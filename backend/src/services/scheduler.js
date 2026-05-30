const cron = require('node-cron');
const { processDueEmails, resetDailyLimits } = require('./emailSender');
const { detectReplies } = require('./replyDetector');

function startScheduler() {
  console.log('🕐 Starting scheduler...');

  let isSending = false;

  // Process due emails every 5 minutes
  // Skip if previous run still in progress to prevent duplicate sends
  cron.schedule('*/5 * * * *', async () => {
    if (isSending) {
      console.log(`[${new Date().toISOString()}] Skipping — previous send still in progress...`);
      return;
    }
    isSending = true;
    console.log(`[${new Date().toISOString()}] Running email sender...`);
    try {
      await processDueEmails();
    } catch (err) {
      console.error('Scheduler error (emailSender):', err.message);
    } finally {
      isSending = false;
    }
  });

  // Check for replies every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log(`[${new Date().toISOString()}] Checking for replies...`);
    try {
      await detectReplies();
    } catch (err) {
      console.error('Scheduler error (replyDetector):', err.message);
    }
  });

  // Reset daily limits every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await resetDailyLimits();
    } catch (err) {
      console.error('Scheduler error (resetLimits):', err.message);
    }
  });

  console.log('✅ Scheduler running');
}

module.exports = { startScheduler };
