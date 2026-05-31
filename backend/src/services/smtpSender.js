const nodemailer = require('nodemailer');
const { pool } = require('../db');

async function getSmtpAccounts(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM smtp_accounts WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  return rows;
}

async function createSmtpTransporter(account) {
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_port === 465,
    auth: {
      user: account.smtp_user,
      pass: account.smtp_password,
    },
    tls: { rejectUnauthorized: false }
  });
}

async function sendSmtpEmail({ account, to, from, senderName, subject, htmlBody, attachmentPath, attachmentFilename, replyToMessageId }) {
  const transporter = await createSmtpTransporter(account);

  const effectiveSubject = replyToMessageId && subject && !/^re:\s*/i.test(subject) ? `Re: ${subject}` : subject;

  const mailOptions = {
    from: `${senderName} <${from}>`,
    to,
    subject: effectiveSubject,
    html: htmlBody,
  };

  if (replyToMessageId) {
    mailOptions.inReplyTo = replyToMessageId;
    mailOptions.references = replyToMessageId;
  }

  if (attachmentPath) {
    const fs = require('fs');
    if (fs.existsSync(attachmentPath)) {
      mailOptions.attachments = [{
        filename: attachmentFilename,
        path: attachmentPath,
      }];
    }
  }

  const info = await transporter.sendMail(mailOptions);
  return {
    messageId: info.messageId,
    threadId: replyToMessageId || info.messageId,
  };
}

async function verifySmtpConnection(host, port, user, password) {
  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(port),
    secure: parseInt(port) === 465,
    auth: { user, pass: password },
    tls: { rejectUnauthorized: false }
  });
  await transporter.verify();
  return true;
}

module.exports = { getSmtpAccounts, sendSmtpEmail, verifySmtpConnection };
