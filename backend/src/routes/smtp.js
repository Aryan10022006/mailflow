const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { verifySmtpConnection } = require('../services/smtpSender');
const { checkImapForReplies } = require('../services/imapChecker');
const router = express.Router();

// Get all SMTP accounts
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, smtp_host, smtp_port, smtp_user, display_name, imap_host, imap_port, is_active, created_at FROM smtp_accounts WHERE user_id = $1',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add SMTP account
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_password, display_name, imap_host, imap_port } = req.body;
    if (!smtp_host || !smtp_port || !smtp_user || !smtp_password) {
      return res.status(400).json({ error: 'All SMTP fields required' });
    }

    // Verify SMTP connection first
    try {
      await verifySmtpConnection(smtp_host, smtp_port, smtp_user, smtp_password);
    } catch (err) {
      return res.status(400).json({ error: `SMTP connection failed: ${err.message}` });
    }

    const { rows } = await pool.query(`
      INSERT INTO smtp_accounts (user_id, smtp_host, smtp_port, smtp_user, smtp_password, display_name, imap_host, imap_port, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
      RETURNING id, smtp_host, smtp_port, smtp_user, display_name, imap_host, imap_port, is_active
    `, [req.userId, smtp_host, parseInt(smtp_port), smtp_user, smtp_password, display_name || smtp_user,
        imap_host || null, imap_port ? parseInt(imap_port) : 993]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test IMAP connection for an existing account
router.post('/:id/test-imap', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM smtp_accounts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });

    await checkImapForReplies(rows[0], ['test-connection-only']);
    res.json({ success: true, message: 'IMAP connection successful' });
  } catch (err) {
    res.status(400).json({ error: `IMAP connection failed: ${err.message}` });
  }
});

// Update IMAP settings on existing account
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { imap_host, imap_port } = req.body;
    const { rows } = await pool.query(`
      UPDATE smtp_accounts SET imap_host = $1, imap_port = $2, updated_at = NOW()
      WHERE id = $3 AND user_id = $4
      RETURNING id, smtp_host, smtp_port, smtp_user, display_name, imap_host, imap_port, is_active
    `, [imap_host || null, imap_port ? parseInt(imap_port) : 993, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete SMTP account
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM smtp_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all sending options (SMTP accounts)
router.get('/sending-options', authMiddleware, async (req, res) => {
  try {
    const { rows: smtpAccounts } = await pool.query(
      'SELECT id, smtp_user, display_name FROM smtp_accounts WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const smtpOptions = smtpAccounts.map(a => ({
      email: a.smtp_user,
      name: a.display_name,
      type: 'smtp',
      smtp_id: a.id,
      label: `${a.display_name} <${a.smtp_user}> (SMTP)`
    }));

    res.json(smtpOptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
