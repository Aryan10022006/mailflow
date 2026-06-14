const { pool } = require('../db');
const { checkForReplies } = require('./gmail');
const { checkImapForReplies } = require('./imapChecker');

async function detectReplies() {
  let activeSends;

  // --- 1. Fetch active sends with their own client, released immediately after ---
  {
    const client = await pool.connect();
    try {
      // FIX: DISTINCT ON requires ORDER BY on the same column to be deterministic.
      // es.message_id added so IMAP matching works against the real RFC 2822 Message-ID.
      const { rows } = await client.query(`
        SELECT DISTINCT ON (es.gmail_thread_id)
          es.gmail_thread_id,
          es.gmail_message_id AS message_id,
          es.contact_id,
          es.sequence_id,
          seq.user_id,
          seq.smtp_account_id,
          c.email AS contact_email
        FROM email_sends es
        JOIN contacts c ON es.contact_id = c.id
        JOIN sequences seq ON es.sequence_id = seq.id
        WHERE es.status = 'sent'
          AND es.gmail_thread_id IS NOT NULL
          AND c.status NOT IN ('replied', 'stopped', 'completed')
          AND seq.status IN ('active', 'paused')
        ORDER BY es.gmail_thread_id, es.sent_at DESC
      `);
      activeSends = rows;
    } catch (err) {
      console.error('Failed to fetch active sends:', err.message);
      return;
    } finally {
      // Always release before any async fan-out so the client is never shared
      client.release();
    }
  }

  if (activeSends.length === 0) return;

  // --- 2. handleReplied: each call gets its own client + transaction ---
  // FIX: Using a fresh client per call means one DB failure cannot poison
  //      the connection used by other concurrent handleReplied calls.
  // FIX: WHERE status != 'replied' guard prevents double-increment when two
  //      threads for the same contact are resolved concurrently.
  const handleReplied = async (send) => {
    const writeClient = await pool.connect();
    try {
      await writeClient.query('BEGIN');

      // Guard: skip if another concurrent call already marked this contact
      const { rowCount: updated } = await writeClient.query(
        `UPDATE contacts
         SET status = 'replied', reply_detected_at = NOW()
         WHERE id = $1 AND status != 'replied'`,
        [send.contact_id]
      );

      if (updated === 0) {
        // Already handled by a concurrent call — nothing more to do
        await writeClient.query('ROLLBACK');
        return;
      }

      const { rowCount: cancelledFollowUps } = await writeClient.query(
        `UPDATE email_sends
         SET status = 'skipped'
         WHERE contact_id = $1 AND status = 'scheduled'`,
        [send.contact_id]
      );

      await writeClient.query(
        `UPDATE sequences SET replied_count = replied_count + 1 WHERE id = $1`,
        [send.sequence_id]
      );

      await writeClient.query(`
        INSERT INTO activity_log
          (sequence_id, contact_id, event_type, description, metadata)
        VALUES ($1, $2, 'reply_detected', $3, $4)
      `, [
        send.sequence_id,
        send.contact_id,
        `Reply detected from ${send.contact_email}. ${cancelledFollowUps} follow-up(s) cancelled.`,
        JSON.stringify({
          threadId: send.gmail_thread_id,
          cancelledFollowUps,
        }),
      ]);

      await writeClient.query('COMMIT');
      console.log(`💬 Reply detected from ${send.contact_email}, ${cancelledFollowUps} follow-ups cancelled`);
    } catch (err) {
      await writeClient.query('ROLLBACK');
      console.error(`Failed to mark reply for ${send.contact_email}:`, err.message);
    } finally {
      writeClient.release();
    }
  };

  const gmailSends = activeSends.filter(s => !s.smtp_account_id);
  const smtpSends  = activeSends.filter(s =>  s.smtp_account_id);

  // --- 3. Gmail-based reply detection (grouped by user_id) ---
  if (gmailSends.length > 0) {
    const byUser = {};
    for (const send of gmailSends) {
      (byUser[send.user_id] ??= []).push(send);
    }

    await Promise.allSettled(
      Object.entries(byUser).map(async ([userId, sends]) => {
        try {
          const threadIds = sends.map(s => s.gmail_thread_id);
          const repliedThreads = await checkForReplies(parseInt(userId), threadIds);

          // FIX: Promise.allSettled so one failed handleReplied doesn't abort the rest
          await Promise.allSettled(
            repliedThreads.map(threadId => {
              const send = sends.find(s => s.gmail_thread_id === threadId);
              return send ? handleReplied(send) : Promise.resolve();
            })
          );
        } catch (err) {
          console.error(`Gmail reply detection error for user ${userId}:`, err.message);
        }
      })
    );
  }

  // --- 4. SMTP/IMAP-based reply detection (grouped by smtp_account_id) ---
  if (smtpSends.length > 0) {
    const bySmtp = {};
    for (const send of smtpSends) {
      (bySmtp[send.smtp_account_id] ??= []).push(send);
    }

    await Promise.allSettled(
      Object.entries(bySmtp).map(async ([smtpAccountId, sends]) => {
        try {
          // FIX: Use pool.query directly — the read client was already released above.
          // No need to hold a client open just for this single lookup.
          const { rows: accounts } = await pool.query(
            'SELECT * FROM smtp_accounts WHERE id = $1',
            [smtpAccountId]
          );

          if (!accounts[0]) {
            console.warn(`No SMTP account found for id ${smtpAccountId}`);
            return;
          }

          // FIX: Pass full send objects (with message_id) instead of bare thread ID
          // strings. checkImapForReplies matches on the RFC 2822 Message-ID header,
          // not the Gmail-internal thread ID numeric string.
          const sendsWithMessageId = sends.filter(s => s.message_id);
          if (sendsWithMessageId.length === 0) {
            console.warn(`No message_id set on sends for SMTP account ${smtpAccountId} — skipping. ` +
              `Ensure message_id is stored on email_sends at send time.`);
            return;
          }

          const repliedThreadIds = await checkImapForReplies(accounts[0], sendsWithMessageId);

          // FIX: Promise.allSettled so one failed handleReplied doesn't abort the rest
          await Promise.allSettled(
            repliedThreadIds.map(threadId => {
              const send = sends.find(s => s.gmail_thread_id === threadId);
              return send ? handleReplied(send) : Promise.resolve();
            })
          );
        } catch (err) {
          console.error(`IMAP reply detection error for SMTP account ${smtpAccountId}:`, err.message);
        }
      })
    );
  }
}

module.exports = { detectReplies };