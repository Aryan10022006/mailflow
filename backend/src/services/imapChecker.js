const { ImapFlow } = require('imapflow');

function deriveImapHost(smtpHost) {
  if (!smtpHost) return null;
  // smtp.gmail.com  → imap.gmail.com
  // smtp.X          → imap.X
  // smtp-auth.X     → mail.X  (iitb-style — smtp-auth prefix doesn't map cleanly)
  if (/^smtp\./i.test(smtpHost)) return smtpHost.replace(/^smtp\./i, 'imap.');
  if (/^smtp-/i.test(smtpHost)) {
    const domain = smtpHost.replace(/^smtp-[^.]+\./i, '');
    return 'mail.' + domain;
  }
  return smtpHost;
}

// Folders searched in priority order.
// Extend if your user base includes cPanel / Yahoo / Outlook domains.
const REPLY_FOLDERS = ['INBOX', 'Junk', 'Spam', '[Gmail]/Spam'];

// FIX: ImapFlow maps directly to IMAP's binary OR command, so { or: [...] }
// must be a binary tree of exactly 2 children at each node — a flat array of
// N conditions will throw or silently fail. Reduce into a right-leaning tree.
function buildOrTree(conditions) {
  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0];
  return conditions.reduce((acc, cond) => ({ or: [acc, cond] }));
}

// FIX: Normalize a Message-ID to always have angle brackets so includes()
// does an exact token match and not an accidental substring match.
// e.g.  "abc@x.com"  →  "<abc@x.com>"
//       "<abc@x.com>" →  "<abc@x.com>"  (idempotent)
function normalizeMessageId(id) {
  if (!id) return '';
  const stripped = id.replace(/^<|>$/g, '');
  return `<${stripped}>`;
}

/**
 * Check an IMAP mailbox for replies to a set of sent emails.
 *
 * @param {object}   account  - smtp_accounts row. Must have smtp_user,
 *                              smtp_password, and imap_host or smtp_host.
 * @param {object[]} sends    - Array of { gmail_thread_id, message_id }.
 *                              message_id must be the RFC 2822 Message-ID
 *                              header value stored at send time.
 * @returns {Promise<string[]>}  gmail_thread_ids for which a reply was found.
 */
async function checkImapForReplies(account, sends) {
  // FIX: Accept send objects with message_id rather than bare thread ID strings.
  // Gmail thread IDs are Google-internal numeric identifiers and never appear
  // in any email header; IMAP In-Reply-To / References matching requires the
  // real RFC 2822 Message-ID.
  const validSends = sends.filter(s => s.message_id);
  if (validSends.length === 0) return [];

  const imapHost = account.imap_host || deriveImapHost(account.smtp_host);
  if (!imapHost) return [];

  const imapPort = account.imap_port || 993;

  // FIX: Distinguish TLS (993) from STARTTLS (143) explicitly rather than
  // relying on port number alone, which breaks on servers requiring explicit
  // STARTTLS negotiation.
  const useTLS      = imapPort === 993;
  const useSTARTTLS = !useTLS && imapPort === 143;

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: useTLS,
    auth: { user: account.smtp_user, pass: account.smtp_password },
    logger: false,
    // FIX: Single tls object — previously a second `tls` key clobbered the
    // STARTTLS spread, so `starttls: 'required'` never took effect. Merge both
    // settings into one object here.
    tls: {
      rejectUnauthorized: false,
      ...(useSTARTTLS && { starttls: 'required' }),
    },
    connectionTimeout: 15000,
    greetingTimeout: 8000,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(`IMAP connect failed (${imapHost}:${imapPort}): ${err.message}`);
  }

  const repliedThreadIds = new Set();

  try {
    // FIX: Search multiple folders — replies can land in Junk/Spam on many
    // providers (Outlook, Yahoo, cPanel). Exit early once all threads resolved.
    for (const folder of REPLY_FOLDERS) {
      if (repliedThreadIds.size === validSends.length) break; // all found

      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        // Folder doesn't exist on this server — skip silently
        continue;
      }

      try {
        const unreplied = validSends.filter(s => !repliedThreadIds.has(s.gmail_thread_id));

        // FIX: One batched OR search per folder instead of N×2 serial round
        // trips. Dramatically reduces latency for large send batches and avoids
        // hitting connectionTimeout under load.
        // Note: the SEARCH command scans the real headers server-side, so
        // searching on `references` is valid even though it's absent from the
        // IMAP ENVELOPE structure.
        const orConditions = unreplied.flatMap(s => {
          const id = s.message_id.replace(/^<|>$/g, '');
          return [
            { header: { 'in-reply-to': id } },
            { header: { references:    id } },
          ];
        });

        // FIX: Build a proper binary OR tree — IMAP OR is a binary operator.
        const batchQuery = buildOrTree(orConditions);
        if (!batchQuery) continue;

        let matchedUids;
        try {
          matchedUids = await client.search(batchQuery, { uid: true });
        } catch (err) {
          // FIX: Log search failures rather than swallowing them silently.
          console.warn(`IMAP search failed in "${folder}" for ${account.smtp_user}:`, err.message);
          continue;
        }

        if (!matchedUids?.length) continue;

        // Fetch the In-Reply-To and References *headers* of matched messages to
        // confirm which thread each reply belongs to.
        // FIX: References is NOT part of the IMAP ENVELOPE (RFC 3501), so
        // msg.envelope.references is always undefined. And envelope.inReplyTo
        // can hold multiple space-separated IDs. Pull both from the raw header
        // source instead and match on normalized angle-bracketed IDs.
        for await (const msg of client.fetch(
          matchedUids,
          { envelope: true, headers: ['in-reply-to', 'references'] },
          { uid: true }
        )) {
          // headers comes back as a Buffer of the requested header lines.
          const headerText = msg.headers ? msg.headers.toString() : '';
          // envelope.inReplyTo is a convenience fallback; may be null.
          const envInReplyTo = msg.envelope?.inReplyTo || '';

          const haystack = `${headerText}\n${envInReplyTo}`;

          for (const s of unreplied) {
            // FIX: Match using normalized angle-bracketed IDs so "abc@x.com"
            // doesn't accidentally substring-match "xyzabc@x.com".
            const needle = normalizeMessageId(s.message_id);
            if (haystack.includes(needle)) {
              repliedThreadIds.add(s.gmail_thread_id);
            }
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    try { await client.logout(); } catch {}
  }

  return [...repliedThreadIds];
}

module.exports = { checkImapForReplies, deriveImapHost };