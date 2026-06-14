const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const { processDueEmails, sendEmail, renderTemplate } = require('../services/emailSender');
const { getSendAsAliases } = require('../services/gmail');
const { sendSmtpEmail } = require('../services/smtpSender');

const upload = multer({
  dest: path.join(__dirname, '../../uploads/'),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});


// Get trashed sequences
router.get('/trash', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sequences WHERE user_id = $1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move to trash
router.post('/:id/trash', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE sequences SET trashed_at = NOW(), status = $1 WHERE id = $2 AND user_id = $3',
      ['stopped', req.params.id, req.userId]
    );
    await pool.query(
      "UPDATE email_sends SET status = 'skipped' WHERE sequence_id = $1 AND status = 'scheduled'",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from trash
router.post('/:id/restore', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE sequences SET trashed_at = NULL, status = $1 WHERE id = $2 AND user_id = $3',
      ['stopped', req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all sequences
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM contacts WHERE sequence_id = s.id) as total_contacts
      FROM sequences s
      WHERE s.user_id = $1 AND s.trashed_at IS NULL
      ORDER BY s.created_at DESC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single sequence with emails
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { rows: seq } = await pool.query(
      'SELECT * FROM sequences WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!seq[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: emails } = await pool.query(
      'SELECT * FROM sequence_emails WHERE sequence_id = $1 ORDER BY step_number',
      [req.params.id]
    );

    res.json({ ...seq[0], emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create sequence
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, from_email, include_signature, open_tracking, send_delay_seconds } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO sequences (user_id, name, from_email, include_signature, open_tracking)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [req.userId, name, from_email, include_signature ?? true, open_tracking ?? true]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update sequence settings
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, from_email, include_signature, open_tracking, send_delay_seconds, smtp_account_id } = req.body;
    const { rows } = await pool.query(`
      UPDATE sequences SET name = $1, from_email = $2, include_signature = $3, open_tracking = $4, send_delay_seconds = $7, smtp_account_id = $8, updated_at = NOW()
      WHERE id = $5 AND user_id = $6 RETURNING *
    `, [name, from_email, include_signature, open_tracking, req.params.id, req.userId, send_delay_seconds ?? 7, smtp_account_id || null]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload CSV
router.post('/:id/csv', authMiddleware, upload.single('csv'), async (req, res) => {
  try {
    const csvPath = req.file.path;
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });

    if (records.length === 0) return res.status(400).json({ error: 'CSV is empty' });

    const columns = Object.keys(records[0]);

    // Delete existing contacts for this sequence
    await pool.query('DELETE FROM contacts WHERE sequence_id = $1', [req.params.id]);
    // Delete existing email_sends
    await pool.query(`
      DELETE FROM email_sends WHERE sequence_id = $1
    `, [req.params.id]);

    // Insert contacts
    for (const record of records) {
      const email = record.email || record.Email || record.EMAIL;
      if (!email) continue;
      await pool.query(
        'INSERT INTO contacts (sequence_id, email, data) VALUES ($1, $2, $3)',
        [req.params.id, email.trim(), JSON.stringify(record)]
      );
    }

    await pool.query(`
      UPDATE sequences SET csv_filename = $1, csv_columns = $2, total_contacts = $3, updated_at = NOW()
      WHERE id = $4
    `, [req.file.originalname, JSON.stringify(columns), records.length, req.params.id]);

    fs.unlinkSync(csvPath);
    res.json({ columns, count: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload attachment
router.post('/:id/attachment', authMiddleware, upload.single('attachment'), async (req, res) => {
  try {
    const attachDir = path.join(__dirname, '../../attachments');
    if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });

    const ext = path.extname(req.file.originalname);
    const newFilename = `${uuidv4()}${ext}`;
    const newPath = path.join(attachDir, newFilename);
    fs.renameSync(req.file.path, newPath);

    // Remove old attachment if exists
    const { rows } = await pool.query('SELECT attachment_path FROM sequences WHERE id = $1', [req.params.id]);
    if (rows[0]?.attachment_path && fs.existsSync(rows[0].attachment_path)) {
      fs.unlinkSync(rows[0].attachment_path);
    }

    await pool.query(`
      UPDATE sequences SET attachment_filename = $1, attachment_path = $2, attachment_mimetype = $3, updated_at = NOW()
      WHERE id = $4
    `, [req.file.originalname, newPath, req.file.mimetype, req.params.id]);

    res.json({ filename: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove attachment
router.delete('/:id/attachment', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT attachment_path FROM sequences WHERE id = $1', [req.params.id]);
    if (rows[0]?.attachment_path && fs.existsSync(rows[0].attachment_path)) {
      fs.unlinkSync(rows[0].attachment_path);
    }
    await pool.query(`
      UPDATE sequences SET attachment_filename = NULL, attachment_path = NULL, attachment_mimetype = NULL
      WHERE id = $1
    `, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save email steps
router.put('/:id/emails', authMiddleware, async (req, res) => {
  try {
    const { emails } = req.body; // array of { step_number, subject, body, scheduled_at, delay_days, delay_hours, delay_minutes }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'At least one email step is required' });
    }

    if (emails.length > 7) {
      return res.status(400).json({ error: 'A sequence can have at most 6 follow-ups (7 total emails)' });
    }

    const sortedSteps = [...emails].sort((a, b) => (a.step_number || 0) - (b.step_number || 0));
    for (let i = 0; i < sortedSteps.length; i += 1) {
      if (sortedSteps[i].step_number !== i + 1) {
        return res.status(400).json({ error: 'Email steps must be numbered consecutively starting at 1' });
      }
    }
    
    // Delete existing steps
    await pool.query('DELETE FROM sequence_emails WHERE sequence_id = $1', [req.params.id]);
    
    for (const email of sortedSteps) {
      await pool.query(`
        INSERT INTO sequence_emails (sequence_id, step_number, subject, body, scheduled_at, delay_days, delay_hours, delay_minutes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [req.params.id, email.step_number, email.subject, email.body, email.scheduled_at || null, email.delay_days || 0, email.delay_hours || 0, email.delay_minutes || 0]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Launch sequence - schedule all initial emails
router.post('/:id/launch', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: seq } = await client.query('SELECT * FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!seq[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    const { rows: emails } = await client.query(
      'SELECT * FROM sequence_emails WHERE sequence_id = $1 ORDER BY step_number',
      [req.params.id]
    );
    if (emails.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No email steps defined' }); }

    const { rows: contacts } = await client.query(
      'SELECT * FROM contacts WHERE sequence_id = $1', [req.params.id]
    );
    if (contacts.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No contacts in sequence' }); }

    const firstEmail = emails[0];
    if (!firstEmail.scheduled_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Initial email needs a scheduled date/time' }); }

    // Schedule initial email for each contact atomically
    for (const contact of contacts) {
      await client.query('DELETE FROM email_sends WHERE contact_id = $1 AND status = $2', [contact.id, 'scheduled']);
      await client.query(`
        INSERT INTO email_sends (sequence_id, contact_id, sequence_email_id, step_number, to_email, status, scheduled_at)
        VALUES ($1, $2, $3, $4, $5, 'scheduled', $6)
      `, [seq[0].id, contact.id, firstEmail.id, 1, contact.email, firstEmail.scheduled_at]);
      await client.query('UPDATE contacts SET status = $1, current_step = 0 WHERE id = $2', ['active', contact.id]);
    }

    await client.query(`
      UPDATE sequences SET status = 'active', sent_count = 0, opened_count = 0, replied_count = 0, failed_count = 0, updated_at = NOW()
      WHERE id = $1
    `, [req.params.id]);

    await client.query(`
      INSERT INTO activity_log (sequence_id, event_type, description)
      VALUES ($1, 'sequence_launched', $2)
    `, [req.params.id, `Sequence launched with ${contacts.length} contacts`]);

    await client.query('COMMIT');
    res.json({ success: true, contactsScheduled: contacts.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Pause sequence
router.post('/:id/pause', authMiddleware, async (req, res) => {
  try {
    await pool.query(`UPDATE sequences SET status = 'paused', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    await pool.query(`INSERT INTO activity_log (sequence_id, event_type, description) VALUES ($1, 'sequence_paused', 'Sequence paused by user')`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume sequence
router.post('/:id/resume', authMiddleware, async (req, res) => {
  try {
    await pool.query(`UPDATE sequences SET status = 'active', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    await pool.query(`INSERT INTO activity_log (sequence_id, event_type, description) VALUES ($1, 'sequence_resumed', 'Sequence resumed by user')`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop sequence
router.post('/:id/stop', authMiddleware, async (req, res) => {
  try {
    await pool.query(`UPDATE sequences SET status = 'stopped', updated_at = NOW() WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    // Cancel all scheduled sends
    await pool.query(`UPDATE email_sends SET status = 'skipped' WHERE sequence_id = $1 AND status = 'scheduled'`, [req.params.id]);
    await pool.query(`UPDATE contacts SET status = 'stopped' WHERE sequence_id = $1 AND status = 'active'`, [req.params.id]);
    await pool.query(`INSERT INTO activity_log (sequence_id, event_type, description) VALUES ($1, 'sequence_stopped', 'Sequence stopped by user')`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate sequence
router.post('/:id/duplicate', authMiddleware, async (req, res) => {
  try {
    const { rows: orig } = await pool.query('SELECT * FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!orig[0]) return res.status(404).json({ error: 'Not found' });

    const { rows: newSeq } = await pool.query(`
      INSERT INTO sequences (user_id, name, from_email, include_signature, open_tracking, attachment_filename, attachment_path, attachment_mimetype, duplicated_from)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [
      req.userId,
      `${orig[0].name} (Copy)`,
      orig[0].from_email,
      orig[0].include_signature,
      orig[0].open_tracking,
      orig[0].attachment_filename,
      orig[0].attachment_path,
      orig[0].attachment_mimetype,
      orig[0].id
    ]);

    // Copy email steps
    const { rows: emails } = await pool.query('SELECT * FROM sequence_emails WHERE sequence_id = $1 ORDER BY step_number', [req.params.id]);
    for (const email of emails) {
      await pool.query(`
        INSERT INTO sequence_emails (sequence_id, step_number, subject, body, scheduled_at, delay_days, delay_hours, delay_minutes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [newSeq[0].id, email.step_number, email.subject, email.body, null, email.delay_days, email.delay_hours, email.delay_minutes || 0]);
      // Note: scheduled_at is cleared on duplicate so user must reschedule
    }

    res.json(newSeq[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Reschedule a specific email send
router.post('/:id/reschedule-send', authMiddleware, async (req, res) => {
  try {
    const { contact_id, step_number, scheduled_at, override_sender } = req.body;

    // Find the send record (failed or scheduled)
    const { rows } = await pool.query(`
      SELECT es.* FROM email_sends es
      JOIN sequences seq ON es.sequence_id = seq.id
      WHERE es.contact_id = $1 AND es.step_number = $2
        AND es.status IN ('failed', 'scheduled', 'skipped')
        AND seq.user_id = $3
      LIMIT 1
    `, [contact_id, step_number, req.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'No send record found' });

    // Handle sender override
    let senderUpdate = '';
    let senderParams = [];
    if (override_sender) {
      if (override_sender.startsWith('smtp:')) {
        const smtpId = override_sender.replace('smtp:', '');
        // Update sequence smtp_account_id temporarily for this contact
        senderUpdate = `, smtp_override = $3`;
        // We store override in the email_send metadata instead
        await pool.query(`UPDATE sequences SET smtp_account_id = $1 WHERE id = $2`,
          [smtpId, rows[0].sequence_id]);
      } else if (override_sender.startsWith('gmail:')) {
        const gmailEmail = override_sender.replace('gmail:', '');
        await pool.query(`UPDATE sequences SET smtp_account_id = NULL, from_email = $1 WHERE id = $2`,
          [gmailEmail, rows[0].sequence_id]);
      }
    }

    await pool.query(`
      UPDATE email_sends SET status = 'scheduled', scheduled_at = $1, error_message = NULL
      WHERE id = $2
    `, [scheduled_at, rows[0].id]);

    // Make sure sequence is active
    await pool.query(`
      UPDATE sequences SET status = 'active' WHERE id = $1 AND user_id = $2 AND status = 'stopped'
    `, [req.params.id, req.userId]);

    // Make sure contact is active
    await pool.query(`
      UPDATE contacts SET status = 'active' WHERE id = $1 AND status IN ('stopped', 'completed')
    `, [contact_id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force send a scheduled email immediately
router.post('/:id/force-send', authMiddleware, async (req, res) => {
  try {
    const { contact_id, step_number } = req.body;

    // Get all data needed to send directly
    const { rows } = await pool.query(`
      SELECT 
        es.*,
        c.email as contact_email,
        c.data as contact_data,
        seq.from_email,
        seq.attachment_path,
        seq.attachment_filename,
        seq.attachment_mimetype,
        seq.include_signature,
        seq.open_tracking,
        seq.smtp_account_id,
        seq.send_delay_seconds,
        se.subject as email_subject,
        se.body as email_body,
        u.signature as user_signature,
        u.gmail_email
      FROM email_sends es
      JOIN contacts c ON es.contact_id = c.id
      JOIN sequences seq ON es.sequence_id = seq.id
      JOIN sequence_emails se ON es.sequence_email_id = se.id
      JOIN users u ON seq.user_id = u.id
      WHERE es.contact_id = $1 AND es.step_number = $2
        AND es.status = 'scheduled' AND seq.user_id = $3
      LIMIT 1
    `, [contact_id, step_number, req.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'No scheduled email found' });

    const send = rows[0];

    // Build and send email directly
    let htmlBody = renderTemplate(send.email_body, send.contact_data);
    if (send.include_signature && send.user_signature) {
      htmlBody += `<br/><br/>--<br/>${send.user_signature}`;
    }
    const subject = renderTemplate(send.email_subject, send.contact_data);

    let result;
    if (send.smtp_account_id) {
      // Send via SMTP
      const { rows: smtpRows } = await pool.query('SELECT * FROM smtp_accounts WHERE id = $1', [send.smtp_account_id]);
      if (!smtpRows[0]) throw new Error('SMTP account not found');
      result = await sendSmtpEmail({
        account: smtpRows[0],
        to: send.contact_email,
        from: smtpRows[0].smtp_user,
        senderName: smtpRows[0].display_name,
        subject,
        htmlBody,
        attachmentPath: send.attachment_path,
        attachmentFilename: send.attachment_filename,
        replyToMessageId: send.step_number > 1 ? send.gmail_message_id : null
      });
    } else {
      // Send via Gmail API
      let senderName = send.from_email || send.gmail_email;
      try {
        const aliases = await getSendAsAliases(req.userId);
        const alias = aliases.find(a => a.sendAsEmail === (send.from_email || send.gmail_email));
        if (alias?.displayName) senderName = alias.displayName;
      } catch (e) { /* use email as fallback */ }

      result = await sendEmail(req.userId, {
        sequenceId: send.sequence_id,
        to: send.contact_email,
        from: send.from_email || send.gmail_email,
        senderName,
        subject,
        htmlBody,
        attachmentPath: send.attachment_path,
        attachmentFilename: send.attachment_filename,
        attachmentMimetype: send.attachment_mimetype,
      trackingPixelId: send.tracking_pixel_id,
      includeTracking: send.open_tracking,
      threadId: send.step_number > 1 ? send.gmail_thread_id : null,
      replyToMessageId: send.step_number > 1 ? send.gmail_message_id : null
      });
    }

    // Mark as sent
    await pool.query(`
      UPDATE email_sends SET status = 'sent', sent_at = NOW(), gmail_message_id = $1, gmail_thread_id = $2
      WHERE id = $3
    `, [result.messageId, result.threadId, send.id]);

    await pool.query(`UPDATE contacts SET current_step = $1 WHERE id = $2`, [send.step_number, send.contact_id]);
    await pool.query(`UPDATE sequences SET sent_count = sent_count + 1 WHERE id = $1`, [send.sequence_id]);
    await pool.query(`
      INSERT INTO activity_log (sequence_id, contact_id, event_type, description)
      VALUES ($1, $2, 'email_sent', $3)
    `, [send.sequence_id, send.contact_id, `Email force-sent to ${send.contact_email} (Step ${send.step_number})`]);

    // Apply sequence delay
    const { rows: seqRows } = await pool.query(
      'SELECT send_delay_seconds FROM sequences WHERE id = $1',
      [send.sequence_id]
    );
    const delaySeconds = seqRows[0]?.send_delay_seconds ?? 7;
    if (delaySeconds > 0) {
      await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Force send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stop a single contact (skip their remaining emails)
router.post('/:id/contacts/:contactId/stop', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.* FROM contacts c
      JOIN sequences seq ON c.sequence_id = seq.id
      WHERE c.id = $1 AND c.sequence_id = $2 AND seq.user_id = $3
    `, [req.params.contactId, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });

    const { rowCount } = await pool.query(
      `UPDATE email_sends SET status = 'skipped' WHERE contact_id = $1 AND status = 'scheduled'`,
      [req.params.contactId]
    );
    await pool.query(`UPDATE contacts SET status = 'stopped' WHERE id = $1`, [req.params.contactId]);
    await pool.query(`
      INSERT INTO activity_log (sequence_id, contact_id, event_type, description)
      VALUES ($1, $2, 'contact_stopped', $3)
    `, [req.params.id, req.params.contactId,
        `${rows[0].email} manually stopped. ${rowCount} scheduled email(s) cancelled.`]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume a stopped contact — schedules the next unsent step immediately
router.post('/:id/contacts/:contactId/resume', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.* FROM contacts c
      JOIN sequences seq ON c.sequence_id = seq.id
      WHERE c.id = $1 AND c.sequence_id = $2 AND seq.user_id = $3
    `, [req.params.contactId, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
    const contact = rows[0];

    const nextStep = (contact.current_step || 0) + 1;
    const { rows: nextEmails } = await pool.query(
      `SELECT * FROM sequence_emails WHERE sequence_id = $1 AND step_number = $2`,
      [req.params.id, nextStep]
    );
    if (nextEmails.length === 0) {
      await pool.query(`UPDATE contacts SET status = 'completed' WHERE id = $1`, [req.params.contactId]);
      return res.json({ success: true, message: 'No more steps — marked completed' });
    }

    // Grab thread/message IDs from last sent email for threading continuity
    const { rows: lastSent } = await pool.query(`
      SELECT gmail_thread_id, gmail_message_id FROM email_sends
      WHERE contact_id = $1 AND status = 'sent'
      ORDER BY step_number DESC LIMIT 1
    `, [req.params.contactId]);

    await pool.query(`
      INSERT INTO email_sends (sequence_id, contact_id, sequence_email_id, step_number, to_email, status, scheduled_at, gmail_thread_id, gmail_message_id)
      VALUES ($1, $2, $3, $4, $5, 'scheduled', NOW(), $6, $7)
    `, [req.params.id, req.params.contactId, nextEmails[0].id, nextStep, contact.email,
        lastSent[0]?.gmail_thread_id || null, lastSent[0]?.gmail_message_id || null]);

    await pool.query(`UPDATE contacts SET status = 'active' WHERE id = $1`, [req.params.contactId]);
    await pool.query(`
      INSERT INTO activity_log (sequence_id, contact_id, event_type, description)
      VALUES ($1, $2, 'contact_resumed', $3)
    `, [req.params.id, req.params.contactId, `${contact.email} resumed at step ${nextStep}.`]);

    res.json({ success: true, nextStep });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete sequence
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM sequences WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get contacts for a sequence
router.get('/:id/contacts', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT c.*, 
        (SELECT json_agg(json_build_object('step', es.step_number, 'status', es.status, 'sent_at', es.sent_at, 'scheduled_at', es.scheduled_at, 'opened_at', es.opened_at) ORDER BY es.step_number)
         FROM email_sends es WHERE es.contact_id = c.id) as sends
      FROM contacts c
      WHERE c.sequence_id = $1
    `;
    const params = [req.params.id];
    if (status) { query += ` AND c.status = $2`; params.push(status); }
    query += ' ORDER BY c.created_at';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get activity log for a sequence
router.get('/:id/activity', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM activity_log WHERE sequence_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
