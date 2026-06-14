const { google } = require('googleapis');
const { getAuthenticatedClient, getSendAsAliases } = require('./gmail');
const { sendSmtpEmail, getSmtpAccounts } = require('./smtpSender');
const { pool } = require('../db');
const path = require('path');
const fs = require('fs');

function renderTemplate(template, data) {
  if (!template || !data) return template || '';
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    if (data[trimmed] !== undefined) return data[trimmed];
    const found = Object.keys(data).find(k => k.toLowerCase() === trimmed.toLowerCase());
    return found !== undefined ? data[found] : match;
  });
}

function buildTrackingPixelUrl(pixelId) {
  return `${process.env.BACKEND_URL}/track/open/${pixelId}`;
}

async function buildMimeMessage({ to, from, senderName, subject, htmlBody, attachmentPath, attachmentFilename, attachmentMimetype, trackingPixelId, includeTracking, replyToMessageId }) {
  const boundary = `boundary_${Date.now()}`;
  let trackedBody = htmlBody;
  if (includeTracking && trackingPixelId) {
    const pixelUrl = buildTrackingPixelUrl(trackingPixelId);
    trackedBody += `<img src="${pixelUrl}" width="1" height="1" style="display:none" />`;
  }
  const hasAttachment = attachmentPath && fs.existsSync(attachmentPath);
  const effectiveSubject = replyToMessageId && subject && !/^re:\s*/i.test(subject) ? `Re: ${subject}` : subject;

  const quoteName = (name) => {
    if (!name) return name || '';
    // If name contains special chars (comma, <, >, \"), quote and escape any quotes/backslashes
    const needsQuote = /[(),:\\"<>@;\/\[\]]|\s,/.test(name) || name.includes(',');
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return needsQuote ? `"${escaped}"` : escaped;
  };

  const fromHeaderName = quoteName(senderName || '');
  let messageParts = [
    `From: ${fromHeaderName} <${from}>`,
    `To: ${to}`,
    `Subject: ${effectiveSubject}`,
    `MIME-Version: 1.0`,
  ];
  if (replyToMessageId) {
    const rfc = replyToMessageId.includes('<') ? replyToMessageId : `<${replyToMessageId}>`;
    messageParts.push(`In-Reply-To: ${rfc}`);
    messageParts.push(`References: ${rfc}`);
  }
  if (hasAttachment) {
    messageParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    messageParts.push('');
    messageParts.push(`--${boundary}`);
    messageParts.push(`Content-Type: text/html; charset="UTF-8"`);
    messageParts.push('');
    messageParts.push(trackedBody);
    messageParts.push('');
    const fileData = fs.readFileSync(attachmentPath);
    const base64File = fileData.toString('base64');
    messageParts.push(`--${boundary}`);
    messageParts.push(`Content-Type: ${attachmentMimetype || 'application/octet-stream'}; name="${attachmentFilename}"`);
    messageParts.push(`Content-Disposition: attachment; filename="${attachmentFilename}"`);
    messageParts.push(`Content-Transfer-Encoding: base64`);
    messageParts.push('');
    messageParts.push(base64File);
    messageParts.push(`--${boundary}--`);
  } else {
    messageParts.push(`Content-Type: text/html; charset="UTF-8"`);
    messageParts.push('');
    messageParts.push(trackedBody);
  }
  const rawMessage = messageParts.join('\r\n');
  return Buffer.from(rawMessage).toString('base64url');
}

async function sendEmail(userId, sendData) {
  const { to, from, senderName, subject, htmlBody, attachmentPath, attachmentFilename, attachmentMimetype, trackingPixelId, includeTracking, threadId, replyToMessageId, sequenceId } = sendData;
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const { rows: userRows } = await pool.query('SELECT gmail_email FROM users WHERE id = $1', [userId]);
  const gmailEmail = userRows[0]?.gmail_email;
  const aliases = await getSendAsAliases(userId).catch(() => []);
  const requestedFrom = from || gmailEmail;
  const validAlias = aliases.find(a => a.sendAsEmail === requestedFrom);
  const safeFrom = validAlias ? requestedFrom : gmailEmail || requestedFrom;
  const safeSenderName = senderName || validAlias?.displayName || safeFrom;

  const raw = await buildMimeMessage({
    to,
    from: safeFrom,
    senderName: safeSenderName,
    subject,
    htmlBody,
    attachmentPath,
    attachmentFilename,
    attachmentMimetype,
    trackingPixelId,
    includeTracking,
    replyToMessageId
  });

  const sendViaGmail = async () => {
    const params = { userId: 'me', requestBody: { raw } };
    if (threadId) params.requestBody.threadId = threadId;
    const response = await gmail.users.messages.send(params);

    // Fetch RFC Message-ID for proper threading
    let rfcMessageId = response.data.id;
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: response.data.id, format: 'metadata', metadataHeaders: ['Message-ID'] });
      const msgIdHeader = msg.data.payload?.headers?.find(h => h.name === 'Message-ID');
      if (msgIdHeader?.value) rfcMessageId = msgIdHeader.value;
    } catch (e) {}

    return { messageId: rfcMessageId, threadId: response.data.threadId, transport: 'gmail' };
  };

  const isRejected = (err) => {
    const message = `${err?.message || ''} ${err?.response?.data?.error?.message || ''} ${err?.response?.data?.error_description || ''}`.toLowerCase();
    return message.includes('message rejected') || message.includes('blocked') || message.includes('invalid_request') || message.includes('rejected');
  };

  try {
    return await sendViaGmail();
  } catch (err) {
    if (!isRejected(err)) throw err;

    const fallbackAccounts = sequenceId ? await getSmtpAccounts(userId).catch(() => []) : [];
    const fallbackAccount = fallbackAccounts[0];
    if (!fallbackAccount) throw err;

    const smtpResult = await sendSmtpEmail({
      account: fallbackAccount,
      to,
      from: fallbackAccount.smtp_user,
      senderName: fallbackAccount.display_name || fallbackAccount.smtp_user,
      subject,
      htmlBody,
      attachmentPath,
      attachmentFilename,
      replyToMessageId: replyToMessageId || threadId || null
    });

    if (sequenceId) {
      await pool.query(
        'UPDATE sequences SET smtp_account_id = $1, from_email = NULL, updated_at = NOW() WHERE id = $2',
        [fallbackAccount.id, sequenceId]
      );
    }

    return { messageId: smtpResult.messageId, threadId: smtpResult.threadId, transport: 'smtp-fallback' };
  }
}

async function processDueEmails() {
  const client = await pool.connect();
  try {
    // Step 1: Atomically lock due emails by changing status to 'sending'
    // This prevents duplicate sends when scheduler overlaps
    await client.query(`
      UPDATE email_sends SET status = 'sending'
      WHERE id IN (
        SELECT es.id
        FROM email_sends es
        JOIN contacts c ON es.contact_id = c.id
        JOIN sequences seq ON es.sequence_id = seq.id
        WHERE es.status = 'scheduled'
          AND es.scheduled_at <= NOW()
          AND seq.status = 'active'
          AND c.status NOT IN ('replied', 'stopped', 'paused')
          AND seq.daily_limit_hit = false
        ORDER BY es.scheduled_at ASC
        LIMIT 50
      )
    `);

    // Step 2: Fetch the locked rows with all needed joins
    const { rows: dueSends } = await client.query(`
      SELECT 
        es.*,
        c.email as contact_email,
        c.data as contact_data,
        c.status as contact_status,
        seq.user_id,
        seq.from_email,
        seq.attachment_path,
        seq.attachment_filename,
        seq.attachment_mimetype,
        seq.include_signature,
        seq.open_tracking,
        seq.send_delay_seconds,
        seq.smtp_account_id,
        seq.status as sequence_status,
        seq.daily_limit_hit,
        se.subject as email_subject,
        se.body as email_body,
        u.signature as user_signature,
        u.gmail_email
      FROM email_sends es
      JOIN contacts c ON es.contact_id = c.id
      JOIN sequences seq ON es.sequence_id = seq.id
      JOIN sequence_emails se ON es.sequence_email_id = se.id
      JOIN users u ON seq.user_id = u.id
      WHERE es.status = 'sending'
      ORDER BY es.scheduled_at ASC
    `);

    if (dueSends.length === 0) return;

    const byUser = {};
    for (const send of dueSends) {
      if (!byUser[send.user_id]) byUser[send.user_id] = [];
      byUser[send.user_id].push(send);
    }

    await Promise.all(Object.entries(byUser).map(async ([userId, sends]) => {
      const userClient = await pool.connect();
      try {
        for (const send of sends) {
          const { rows: currentRows } = await userClient.query(`
            SELECT es.status AS send_status, c.status AS contact_status
            FROM email_sends es
            JOIN contacts c ON c.id = es.contact_id
            WHERE es.id = $1
          `, [send.id]);

          const current = currentRows[0];
          if (
            !current ||
            ['replied', 'stopped', 'completed'].includes(current.contact_status) ||
            current.send_status !== 'sending'
          ) {
            await userClient.query(`UPDATE email_sends SET status = 'skipped' WHERE id = $1`, [send.id]);
            continue;
          }
          try {
            let htmlBody = renderTemplate(send.email_body, send.contact_data);
            if (send.include_signature && send.user_signature) {
              htmlBody += `<br/><br/>--<br/>${send.user_signature}`;
            }

            // Fix: fallback subject for follow-ups
            let subject = renderTemplate(send.email_subject, send.contact_data);
            if (!subject && send.step_number > 1) {
              const { rows: step1 } = await userClient.query(
                `SELECT se.subject FROM sequence_emails se WHERE se.sequence_id = $1 AND se.step_number = 1`,
                [send.sequence_id]
              );
              const s1 = step1[0]?.subject ? renderTemplate(step1[0].subject, send.contact_data) : '';
              subject = s1 ? `Re: ${s1}` : 'Re: Following up';
            }

            let result;
            if (send.smtp_account_id) {
              const { rows: smtpAccounts } = await userClient.query('SELECT * FROM smtp_accounts WHERE id = $1', [send.smtp_account_id]);
              if (!smtpAccounts[0]) throw new Error('SMTP account not found');
              const smtpResult = await sendSmtpEmail({
                account: smtpAccounts[0],
                to: send.contact_email,
                from: smtpAccounts[0].smtp_user,
                senderName: smtpAccounts[0].display_name,
                subject,
                htmlBody,
                attachmentPath: send.attachment_path,
                attachmentFilename: send.attachment_filename,
                replyToMessageId: send.step_number > 1 ? send.gmail_message_id : null
              });
              result = { messageId: smtpResult.messageId, threadId: smtpResult.threadId };
            } else {
              let senderName = send.from_email || send.gmail_email;
              try {
                const aliases = await getSendAsAliases(parseInt(userId));
                const alias = aliases.find(a => a.sendAsEmail === (send.from_email || send.gmail_email));
                if (alias?.displayName) senderName = alias.displayName;
              } catch (e) {}
              result = await sendEmail(parseInt(userId), {
                sequenceId: send.sequence_id,
                to: send.contact_email,
                from: send.from_email || send.gmail_email,
                senderName, subject, htmlBody,
                attachmentPath: send.attachment_path,
                attachmentFilename: send.attachment_filename,
                attachmentMimetype: send.attachment_mimetype,
                trackingPixelId: send.tracking_pixel_id,
                includeTracking: send.open_tracking,
                threadId: send.step_number > 1 ? send.gmail_thread_id : null,
                replyToMessageId: send.step_number > 1 ? send.gmail_message_id : null
              });
                }


            await userClient.query(
              `UPDATE email_sends SET status = 'sent', sent_at = NOW(), gmail_message_id = $1, gmail_thread_id = $2 WHERE id = $3`,
              [result.messageId, result.threadId, send.id]
            );
            await userClient.query(`UPDATE contacts SET current_step = $1 WHERE id = $2`, [send.step_number, send.contact_id]);
            await userClient.query(`UPDATE sequences SET sent_count = sent_count + 1 WHERE id = $1`, [send.sequence_id]);
            await userClient.query(
              `INSERT INTO activity_log (sequence_id, contact_id, event_type, description, metadata) VALUES ($1, $2, 'email_sent', $3, $4)`,
              [send.sequence_id, send.contact_id, `Email sent to ${send.contact_email} (Step ${send.step_number})`, JSON.stringify({ messageId: result.messageId, step: send.step_number })]
            );

            await scheduleNextFollowUp(userClient, send, result.threadId, result.messageId);

            console.log(`✅ Sent email to ${send.contact_email} (Step ${send.step_number})`);
            const delaySeconds = send.send_delay_seconds ?? 7;
            if (delaySeconds > 0) {
              console.log(`⏳ Waiting ${delaySeconds}s before next email...`);
              await new Promise(r => setTimeout(r, delaySeconds * 1000));
            }

          } catch (err) {
            const isLimitError = err.message?.includes('429') || err.message?.toLowerCase().includes('limit') || err.message?.includes('rateLimitExceeded');
            if (isLimitError) {
              // Revert 'sending' back to 'scheduled' for remaining emails in this sequence
              await userClient.query(
                `UPDATE email_sends SET status = 'scheduled' WHERE status = 'sending' AND sequence_id = $1`,
                [send.sequence_id]
              );
              await userClient.query(`UPDATE sequences SET daily_limit_hit = true, daily_limit_reset_at = NOW() + INTERVAL '24 hours' WHERE id = $1`, [send.sequence_id]);
              await userClient.query(`INSERT INTO activity_log (sequence_id, event_type, description) VALUES ($1, 'limit_reached', 'Gmail daily sending limit reached. Sending will resume tomorrow.')`, [send.sequence_id]);
              console.log(`⚠️ Gmail limit hit for sequence ${send.sequence_id}`);
              break;
            } else {
              // Mark as failed (not 'sending')
              await userClient.query(`UPDATE email_sends SET status = 'failed', error_message = $1 WHERE id = $2`, [err.message, send.id]);
              await userClient.query(`UPDATE sequences SET failed_count = failed_count + 1 WHERE id = $1`, [send.sequence_id]);
              console.error(`❌ Failed to send to ${send.contact_email}:`, err.message);
            }
          }
        }
      } finally {
        userClient.release();
      }
    }));
  } finally {
    client.release();
  }
}

async function scheduleNextFollowUp(client, completedSend, threadId, rfcMessageId) {
  const { rows: nextEmail } = await client.query(
    `SELECT se.* FROM sequence_emails se WHERE se.sequence_id = $1 AND se.step_number = $2`,
    [completedSend.sequence_id, completedSend.step_number + 1]
  );
  if (nextEmail.length === 0) {
    await client.query(`UPDATE contacts SET status = 'completed' WHERE id = $1`, [completedSend.contact_id]);
    return;
  }
  const next = nextEmail[0];
  const delayInterval = `${next.delay_days || 0} days ${next.delay_hours || 0} hours ${next.delay_minutes || 0} minutes`;
  await client.query(`
    INSERT INTO email_sends (sequence_id, contact_id, sequence_email_id, step_number, to_email, status, scheduled_at, gmail_thread_id, gmail_message_id)
    VALUES ($1, $2, $3, $4, $5, 'scheduled', NOW() + $6::interval, $7, $8)
  `, [
    completedSend.sequence_id,
    completedSend.contact_id,
    next.id,
    next.step_number,
    completedSend.contact_email,
    delayInterval,
    threadId,
    rfcMessageId
  ]);
}

async function resetDailyLimits() {
  await pool.query(`UPDATE sequences SET daily_limit_hit = false, daily_limit_reset_at = NULL WHERE daily_limit_hit = true AND daily_limit_reset_at <= NOW()`);
}

module.exports = { processDueEmails, resetDailyLimits, renderTemplate, sendEmail };
