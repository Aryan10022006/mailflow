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

  // Auto-refresh token
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await pool.query(
        'UPDATE users SET gmail_access_token = $1 WHERE id = $2',
        [tokens.access_token, userId]
      );
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
      const thread = await gmail.users.threads.get({ userId: 'me', id: threadId });
      const messages = thread.data.messages || [];
      // If thread has more than 1 message, someone replied
      if (messages.length > 1) {
        repliedThreads.push(threadId);
      }
    } catch (e) {
      // Thread not found or deleted, skip
    }
  }
  return repliedThreads;
}

module.exports = { getAuthUrl, exchangeCode, getAuthenticatedClient, getSendAsAliases, fetchGmailSignature, checkForReplies };
