const { pool } = require('../db');
const { checkForReplies } = require('./gmail');

async function detectReplies() {
  const client = await pool.connect();
  try {
    // Get all active sent emails with thread IDs
    const { rows: activeSends } = await client.query(`
      SELECT DISTINCT ON (es.gmail_thread_id)
        es.gmail_thread_id,
        es.contact_id,
        es.sequence_id,
        seq.user_id,
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

    // Group by user
    const byUser = {};
    for (const send of activeSends) {
      if (!byUser[send.user_id]) byUser[send.user_id] = [];
      byUser[send.user_id].push(send);
    }

    for (const [userId, sends] of Object.entries(byUser)) {
      const threadIds = sends.map(s => s.gmail_thread_id);
      const repliedThreads = await checkForReplies(parseInt(userId), threadIds);

      for (const threadId of repliedThreads) {
        const send = sends.find(s => s.gmail_thread_id === threadId);
        if (!send) continue;

        // Mark contact as replied
        await client.query(`
          UPDATE contacts SET status = 'replied', reply_detected_at = NOW() WHERE id = $1
        `, [send.contact_id]);

        // Cancel all pending follow-ups for this contact
        const { rowCount } = await client.query(`
          UPDATE email_sends SET status = 'skipped' 
          WHERE contact_id = $1 AND status = 'scheduled'
        `, [send.contact_id]);

        // Update sequence replied count
        await client.query(`
          UPDATE sequences SET replied_count = replied_count + 1 WHERE id = $1
        `, [send.sequence_id]);

        // Log activity
        await client.query(`
          INSERT INTO activity_log (sequence_id, contact_id, event_type, description, metadata)
          VALUES ($1, $2, 'reply_detected', $3, $4)
        `, [
          send.sequence_id,
          send.contact_id,
          `Reply detected from ${send.contact_email}. ${rowCount} follow-up(s) cancelled.`,
          JSON.stringify({ threadId, cancelledFollowUps: rowCount })
        ]);

        console.log(`💬 Reply detected from ${send.contact_email}, ${rowCount} follow-ups cancelled`);
      }
    }
  } catch (err) {
    console.error('Reply detection error:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { detectReplies };
