const { google } = require('googleapis');
const { pool } = require('../db');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

function getAuthUrl() {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
}

async function exchangeCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  return { tokens, email: data.email };
}

async function getAuthenticatedClient(userId) {
  const { rows } = await pool.query(
    'SELECT gmail_access_token, gmail_refresh_token FROM users WHERE id = $1',
    [userId]
  );
  if (!rows[0] || !rows[0].gmail_access_token) throw new Error('Gmail not connected');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: rows[0].gmail_access_token,
    refresh_token: rows[0].gmail_refresh_token
  });

  // Auto-refresh token.
  // FIX: Google occasionally rotates the refresh_token. The previous version
  // only persisted access_token, silently discarding any new refresh_token —
  // which eventually invalidates the stored credentials and forces a manual
  // reconnect. Persist refresh_token whenever it is present.
  oauth2Client.on('tokens', async (tokens) => {
    try {
      if (tokens.refresh_token) {
        await pool.query(
          'UPDATE users SET gmail_access_token = $1, gmail_refresh_token = $2 WHERE id = $3',
          [tokens.access_token, tokens.refresh_token, userId]
        );
      } else if (tokens.access_token) {
        await pool.query(
          'UPDATE users SET gmail_access_token = $1 WHERE id = $2',
          [tokens.access_token, userId]
        );
      }
    } catch (err) {
      console.error(`Failed to persist refreshed Gmail tokens for user ${userId}:`, err.message);
    }
  });

  return oauth2Client;
}

async function getSendAsAliases(userId) {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  return res.data.sendAs || [];
}

async function fetchGmailSignature(userId) {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  const primary = (res.data.sendAs || []).find(s => s.isPrimary);
  return primary?.signature || '';
}

async function checkForReplies(userId, threadIds) {
  if (!threadIds || threadIds.length === 0) return [];
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const repliedThreads = [];
  for (const threadId of threadIds) {
    try {
      // FIX: Fetch only metadata (no bodies) — faster and cheaper.
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From'],
      });
      const messages = thread.data.messages || [];

      // FIX: The previous check (messages.length > 1) treated ANY additional
      // message as a reply — including our own sequence follow-ups sent into
      // the same thread. That marked never-replied contacts as 'replied' and
      // prematurely cancelled the rest of the sequence.
      //
      // A message we sent carries the SENT label; an inbound reply does not.
      // So a genuine reply exists iff any message lacks the SENT label.
      const gotReply = messages.some(m => !(m.labelIds || []).includes('SENT'));
      if (gotReply) {
        repliedThreads.push(threadId);
      }
    } catch (e) {
      // FIX: Don't swallow everything silently. A 404 (thread deleted) is
      // benign and skippable, but auth failures (401 invalid_grant) or rate
      // limits would otherwise look identical to "no reply" forever.
      const status = e?.code || e?.response?.status;
      if (status !== 404) {
        console.warn(`checkForReplies error for thread ${threadId} (user ${userId}):`, e.message);
      }
    }
  }
  return repliedThreads;
}

module.exports = { getAuthUrl, exchangeCode, getAuthenticatedClient, getSendAsAliases, fetchGmailSignature, checkForReplies };