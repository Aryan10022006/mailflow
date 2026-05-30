const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { verifySmtpConnection } = require('../services/smtpSender');
const router = express.Router();

// Get all SMTP accounts
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, smtp_host, smtp_port, smtp_user, display_name, is_active, created_at FROM smtp_accounts WHERE user_id = $1',
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
    const { smtp_host, smtp_port, smtp_user, smtp_password, display_name } = req.body;
    if (!smtp_host || !smtp_port || !smtp_user || !smtp_password) {
      return res.status(400).json({ error: 'All SMTP fields required' });
    }

    // Verify connection first
    try {
      await verifySmtpConnection(smtp_host, smtp_port, smtp_user, smtp_password);
    } catch (err) {
      return res.status(400).json({ error: `SMTP connection failed: ${err.message}` });
    }

    const { rows } = await pool.query(`
      INSERT INTO smtp_accounts (user_id, smtp_host, smtp_port, smtp_user, smtp_password, display_name, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id, smtp_host, smtp_port, smtp_user, display_name, is_active
    `, [req.userId, smtp_host, parseInt(smtp_port), smtp_user, smtp_password, display_name || smtp_user]);

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

// Get all sending options (Gmail aliases + SMTP accounts)
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
