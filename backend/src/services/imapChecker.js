const { ImapFlow } = require('imapflow');

function deriveImapHost(smtpHost) {
  if (!smtpHost) return null;
  // smtp.gmail.com  → imap.gmail.com
  // smtp.X          → imap.X
  // smtp-auth.X     → mail.X  (iitb-style — smtp-auth prefix doesn't map cleanly, fall back to mail.)
  if (/^smtp\./i.test(smtpHost)) return smtpHost.replace(/^smtp\./i, 'imap.');
  if (/^smtp-/i.test(smtpHost)) {
    // e.g. smtp-auth.iitb.ac.in → mail.iitb.ac.in
    const domain = smtpHost.replace(/^smtp-[^.]+\./i, '');
    return 'mail.' + domain;
  }
  return smtpHost;
}

async function checkImapForReplies(account, threadIds) {
  if (!threadIds || threadIds.length === 0) return [];

  const imapHost = account.imap_host || deriveImapHost(account.smtp_host);
  if (!imapHost) return [];

  const imapPort = account.imap_port || 993;

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: account.smtp_user, pass: account.smtp_password },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 5000,
  });

  const repliedSet = new Set();

  try {
    await client.connect();
  } catch (err) {
    // Connection failed — rethrow so caller can log and skip this account
    throw new Error(`IMAP connect failed (${imapHost}:${imapPort}): ${err.message}`);
  }

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const threadId of threadIds) {
        // Strip angle brackets; IMAP HEADER search does substring match on header body
        const searchId = threadId.replace(/^<|>$/g, '');
        try {
          const byInReplyTo = await client.search({ header: { 'in-reply-to': searchId } });
          if (byInReplyTo && byInReplyTo.length > 0) {
            repliedSet.add(threadId);
            continue;
          }
          // Also check References in case the reply thread grew beyond one level
          const byRefs = await client.search({ header: { references: searchId } });
          if (byRefs && byRefs.length > 0) {
            repliedSet.add(threadId);
          }
        } catch {
          // Search for this specific ID failed — skip it without aborting the rest
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch {}
  }

  return [...repliedSet];
}

module.exports = { checkImapForReplies, deriveImapHost };
