require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const { startScheduler } = require('./services/scheduler');
const authRoutes = require('./routes/auth');
const sequenceRoutes = require('./routes/sequences');
const trackingRoutes = require('./routes/tracking');
const aiRoutes = require('./routes/ai');
const folderRoutes = require('./routes/folders');
const smtpRoutes = require('./routes/smtp');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/sequences', sequenceRoutes);
app.use('/track', trackingRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/smtp', smtpRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Start
async function start() {
  try {
    await initDB();
    // Reset any emails stuck in 'sending' state from a previous crash
    // Use a fresh client to avoid conflict with initDB connection
    const { pool } = require('./db');
    const stuckClient = await pool.connect();
    try {
      const stuck = await stuckClient.query("UPDATE email_sends SET status = 'scheduled' WHERE status = 'sending'");
      if (stuck.rowCount > 0) console.log(`🔄 Reset ${stuck.rowCount} stuck sending email(s)`);
    } finally {
      stuckClient.release();
    }
    startScheduler();
    app.listen(PORT, () => {
      console.log(`🚀 MailFlow backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
