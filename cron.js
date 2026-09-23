const PayoutName = require('./models/PayoutName');
const PayoutNameLog = require('./models/PayoutNameLog');

// Run maturity check
const checkMaturity = async () => {
  try {
    const today = new Date();
    // find all payments that have status received and maturityDate <= today
    console.log("running cron");
    const maturingNames = await PayoutName.find({
      paymentStatus: 'received',
      maturityDate: { $lte: today }
    });

    if (maturingNames.length > 0) {
      const ids = maturingNames.map(n => n._id);
      await PayoutName.updateMany(
        { _id: { $in: ids } },
        { $set: { paymentStatus: 'matured' } }
      );

      try {
        const logs = maturingNames.map(n => ({
          payoutName: n._id,
          action: 'matured',
          amount: n.amount || 0,
          paymentStatus: 'matured',
          paymentDate: n.paymentReceivedDate || null,
          maturityDate: n.maturityDate || null,
          narration: 'Marked as matured by automated system cron',
          performedBy: null,
          performedByRole: 'system',
          timestamp: new Date()
        }));
        await PayoutNameLog.insertMany(logs);
      } catch (logErr) {
        console.error("[Cron] Error logging maturity events:", logErr);
      }

      console.log(`[Cron] Marked ${maturingNames.length} payout names as matured.`);
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
