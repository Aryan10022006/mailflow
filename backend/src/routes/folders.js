const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// Get all folders with sequence counts
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, 
        COUNT(s.id) as sequence_count
      FROM folders f
      LEFT JOIN sequences s ON s.folder_id = f.id AND s.trashed_at IS NULL
      WHERE f.user_id = $1
      GROUP BY f.id
      ORDER BY f.created_at ASC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create folder
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Folder name required' });
    const { rows } = await pool.query(`
      INSERT INTO folders (user_id, name, color)
      VALUES ($1, $2, $3) RETURNING *
    `, [req.userId, name.trim(), color || '#6c63ff']);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename folder
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, color } = req.body;
    const { rows } = await pool.query(`
      UPDATE folders SET name = COALESCE($1, name), color = COALESCE($2, color), updated_at = NOW()
      WHERE id = $3 AND user_id = $4 RETURNING *
    `, [name, color, req.params.id, req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete folder (moves sequences to null)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE sequences SET folder_id = NULL WHERE folder_id = $1', [req.params.id]);
    await pool.query('DELETE FROM folders WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move sequence to folder
router.post('/move', authMiddleware, async (req, res) => {
  try {
    const { sequence_id, folder_id } = req.body;
    await pool.query(
      'UPDATE sequences SET folder_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
      [folder_id || null, sequence_id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
