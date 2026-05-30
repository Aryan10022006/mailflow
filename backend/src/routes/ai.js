const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

router.post('/suggest', authMiddleware, async (req, res) => {
  try {
    const { mode, subject, body } = req.body;
    const bodyText = body.replace(/<[^>]*>/g, ' ').trim();

    const prompts = {
      improve: `You are an expert cold email copywriter. Improve this cold email body to be more professional, concise and compelling. Keep it under 150 words. Preserve any {{variables}}. Return only the improved email body as plain text, no explanation.\n\nSubject: ${subject}\nBody: ${bodyText}`,
      subject: `You are an expert cold email copywriter. Suggest 5 compelling subject lines for this cold email. Make them short (under 8 words), curiosity-driven, and not spammy. Preserve any {{variables}} if relevant. Return only a numbered list of 5 subject lines.\n\nEmail body: ${bodyText}`,
      followup: `You are an expert cold email copywriter. Write a short, friendly follow-up email for someone who didn't reply to this initial email. Keep it under 100 words, reference the original email naturally. Preserve any {{variables}}. Return only the follow-up email body as plain text.\n\nOriginal subject: ${subject}\nOriginal body: ${bodyText}`,
      spam: `You are an email deliverability expert. Analyze this cold email for spam trigger words and issues that could cause it to land in spam. List specific problems found and suggest fixes. Be concise.\n\nSubject: ${subject}\nBody: ${bodyText}`
    };

    if (!prompts[mode]) return res.status(400).json({ error: 'Invalid mode' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompts[mode] }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ result: data.content?.[0]?.text || 'No response.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
