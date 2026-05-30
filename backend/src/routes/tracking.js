const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/open/:pixelId', async (req, res) => {
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);

  // Track open in background
  try {
    const { rows } = await pool.query(
      'SELECT * FROM email_sends WHERE tracking_pixel_id = $1',
      [req.params.pixelId]
    );
    if (!rows[0] || rows[0].opened_at) return; // already tracked

    await pool.query(
      'UPDATE email_sends SET opened_at = NOW() WHERE tracking_pixel_id = $1',
      [req.params.pixelId]
    );

    await pool.query(
      'UPDATE sequences SET opened_count = opened_count + 1 WHERE id = $1',
      [rows[0].sequence_id]
    );

    await pool.query(`
      INSERT INTO activity_log (sequence_id, contact_id, event_type, description)
      VALUES ($1, $2, 'email_opened', 'Email opened')
    `, [rows[0].sequence_id, rows[0].contact_id]);

  } catch (e) {
    // Silent fail - don't affect email rendering
  }
});

module.exports = router;
