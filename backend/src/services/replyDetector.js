const { pool } = require('../db');
const { checkForReplies } = require('./gmail');
const { checkImapForReplies } = require('./imapChecker');

async function detectReplies() {
  const client = await pool.connect();
  try {
    // Fetch all active sent emails that still need reply-checking.
    // We include smtp_account_id so we can route SMTP sends through IMAP.
    const { rows: activeSends } = await client.query(`
      SELECT DISTINCT ON (es.gmail_thread_id)
        es.gmail_thread_id,
        es.contact_id,
        es.sequence_id,
        seq.user_id,
        seq.smtp_account_id,
        c.email as contact_email
      FROM email_sends es
      JOIN contacts c ON es.contact_id = c.id
      JOIN sequences seq ON es.sequence_id = seq.id
      WHERE es.status = 'sent'
        AND es.gmail_thread_id IS NOT NULL
        AND c.status NOT IN ('replied', 'stopped', 'completed')
        AND seq.status IN ('active', 'paused')
    `);

    if (activeSends.length === 0) return;

    // Shared handler: mark contact replied, cancel scheduled follow-ups, log
    const handleReplied = async (send) => {
      await client.query(
        `UPDATE contacts SET status = 'replied', reply_detected_at = NOW() WHERE id = $1`,
        [send.contact_id]
      );

      const { rowCount } = await client.query(
        `UPDATE email_sends SET status = 'skipped' WHERE contact_id = $1 AND status = 'scheduled'`,
        [send.contact_id]
      );

      await client.query(
        `UPDATE sequences SET replied_count = replied_count + 1 WHERE id = $1`,
        [send.sequence_id]
      );

      await client.query(`
        INSERT INTO activity_log (sequence_id, contact_id, event_type, description, metadata)
        VALUES ($1, $2, 'reply_detected', $3, $4)
      `, [
        send.sequence_id,
        send.contact_id,
        `Reply detected from ${send.contact_email}. ${rowCount} follow-up(s) cancelled.`,
        JSON.stringify({ threadId: send.gmail_thread_id, cancelledFollowUps: rowCount })
      ]);

      console.log(`💬 Reply detected from ${send.contact_email}, ${rowCount} follow-ups cancelled`);
    };

    // Split sends: sequences with smtp_account_id use IMAP; others use Gmail API
    const gmailSends = activeSends.filter(s => !s.smtp_account_id);
    const smtpSends  = activeSends.filter(s =>  s.smtp_account_id);

    // --- Gmail-based reply detection (grouped by user) ---
    if (gmailSends.length > 0) {
      const byUser = {};
      for (const send of gmailSends) {
        if (!byUser[send.user_id]) byUser[send.user_id] = [];
        byUser[send.user_id].push(send);
      }

      for (const [userId, sends] of Object.entries(byUser)) {
        try {
          const threadIds = sends.map(s => s.gmail_thread_id);
          const repliedThreads = await checkForReplies(parseInt(userId), threadIds);
          for (const threadId of repliedThreads) {
            const send = sends.find(s => s.gmail_thread_id === threadId);
            if (send) await handleReplied(send);
          }
        } catch (err) {
          console.error(`Gmail reply detection error for user ${userId}:`, err.message);
        }
      }
    }

    // --- SMTP-based reply detection (grouped by smtp_account_id, checked via IMAP) ---
    if (smtpSends.length > 0) {
      const bySmtp = {};
      for (const send of smtpSends) {
        if (!bySmtp[send.smtp_account_id]) bySmtp[send.smtp_account_id] = [];
        bySmtp[send.smtp_account_id].push(send);
      }

      for (const [smtpAccountId, sends] of Object.entries(bySmtp)) {
        try {
          const { rows: accounts } = await client.query(
            'SELECT * FROM smtp_accounts WHERE id = $1',
            [smtpAccountId]
          );
          if (!accounts[0]) continue;

          const threadIds = sends.map(s => s.gmail_thread_id);
          const repliedThreadIds = await checkImapForReplies(accounts[0], threadIds);
          for (const threadId of repliedThreadIds) {
            const send = sends.find(s => s.gmail_thread_id === threadId);
            if (send) await handleReplied(send);
          }
        } catch (err) {
          console.error(`IMAP reply detection error for SMTP account ${smtpAccountId}:`, err.message);
        }
      }
    }

  } catch (err) {
    console.error('Reply detection error:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { detectReplies };
