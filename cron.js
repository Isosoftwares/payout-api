const PayoutName = require('./models/PayoutName');

// Run maturity check
const checkMaturity = async () => {
  try {
    const today = new Date();
    // find all payments that have status received and maturityDate <= today
    console.log("running cron")
    const result = await PayoutName.updateMany(
      { 
        paymentStatus: 'received',
        maturityDate: { $lte: today }
      },
      { 
        $set: { paymentStatus: 'matured' } 
      }
    );
    if (result.modifiedCount > 0) {
      console.log(`[Cron] Marked ${result.modifiedCount} payout names as matured.`);
    } else {
      console.log("[Cron] No payout names to mark as matured.");
    }
  } catch (error) {
    console.error("[Cron] Error checking maturity:", error);
  }
};

// Start the cron job
const startCron = () => {
  // Check immediately
  checkMaturity();
  // Then check every hour
  setInterval(checkMaturity, 1000 * 60 * 60);
};

module.exports = { startCron, checkMaturity };
