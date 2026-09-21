const PayoutTransaction = require('../models/PayoutTransaction');
const PayoutName = require('../models/PayoutName');
const User = require('../models/User');
const Notification = require('../models/Notification');
const telegramService = require('../services/telegramService');
// Note: PaymentMethod is referenced, but we might just log the ID.

const getAdmins = async (req, res) => {
  try {
    const admins = await User.find({ role: 'admin' }).select('firstName lastName email');
    res.status(200).json({ success: true, data: admins });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getClientsByAdmin = async (req, res) => {
  try {
    const { adminId } = req.params;
    let filter = { role: 'client' };
    if (adminId && adminId !== 'all') {
      filter.createdBy = adminId;
    }
    const clients = await User.find(filter).select('profile email feePercentage usdBuyPrice usdSellPrice paymentMethods');
    res.status(200).json({ success: true, data: clients });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getClientMaturedNames = async (req, res) => {
  try {
    const { clientId } = req.params;
    const names = await PayoutName.find({
      allocatedTo: clientId,
      paymentStatus: 'matured'
    });
    res.status(200).json({ success: true, data: names });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getAdminMaturedStats = async (req, res) => {
  try {
    const { adminId } = req.params;
    let clientIds = [];
    
    if (adminId && adminId !== 'all') {
      const clients = await User.find({ role: 'client', createdBy: adminId }).select('_id');
      clientIds = clients.map(c => c._id);
    }
    
    const matchStage = { paymentStatus: 'matured' };
    if (adminId && adminId !== 'all') {
      matchStage.allocatedTo = { $in: clientIds };
    } else {
      // If all, just match any matured name allocated to a client
      matchStage.allocatedTo = { $ne: null };
    }

    const stats = await PayoutName.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          totalAmount: { $sum: "$amount" }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: stats[0] || { totalCount: 0, totalAmount: 0 }
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const executeBatchPayout = async (req, res) => {
  try {
    const adminId = req.user.id;
    const {
      clientId,
      payoutNameIds,
      payoutCurrency, // 'USD' or 'KES'
      paymentMethodId,
      referenceId
    } = req.body;

    if (!payoutNameIds || payoutNameIds.length === 0) {
      return res.status(400).json({ message: "No payout names selected." });
    }

    const client = await User.findById(clientId);
    if (!client) {
      return res.status(404).json({ message: "Client not found." });
    }

    // Verify all names belong to client and are matured
    const names = await PayoutName.find({
      _id: { $in: payoutNameIds },
      allocatedTo: clientId,
      paymentStatus: 'matured'
    });

    if (names.length !== payoutNameIds.length) {
      return res.status(400).json({ message: "Some selected names are invalid, already paid, or not matured." });
    }

    let grossAmountUSD = 0;
    names.forEach(n => {
      grossAmountUSD += (n.amount || 0);
    });

    const feePercentage = client.feePercentage || 0;
    const feeAmountUSD = (grossAmountUSD * feePercentage) / 100;
    const netAmountUSD = grossAmountUSD - feeAmountUSD;

    const usdBuyPrice = client.usdBuyPrice || 1;
    const usdSellPrice = client.usdSellPrice || 1;

    let finalPayoutAmount = 0;
    let spreadProfitUSD = 0;

    if (payoutCurrency === 'KES') {
      finalPayoutAmount = netAmountUSD * usdBuyPrice;
      // Spread profit isn't strictly defined for KES payout unless they use a different market rate. We keep it 0 or minimal.
    } else if (payoutCurrency === 'USD') {
      // (Net USD * usdBuyPrice) / usdSellPrice
      finalPayoutAmount = (netAmountUSD * usdBuyPrice) / usdSellPrice;
      spreadProfitUSD = netAmountUSD - finalPayoutAmount; // Because finalPayoutAmount is in USD
    } else {
      return res.status(400).json({ message: "Invalid payout currency. Must be USD or KES." });
    }

    const totalProfitUSD = feeAmountUSD + spreadProfitUSD;

    // Create Transaction
    const transaction = await PayoutTransaction.create({
      clientId,
      adminId,
      payoutNames: payoutNameIds,
      grossAmountUSD,
      feePercentage,
      feeAmountUSD,
      netAmountUSD,
      payoutCurrency,
      exchangeRateBuy: usdBuyPrice,
      exchangeRateSell: usdSellPrice,
      finalPayoutAmount,
      spreadProfitUSD,
      totalProfitUSD,
      paymentMethodId,
      referenceId,
      status: 'completed'
    });

    // Update PayoutNames status to paid and reset amount
    await PayoutName.updateMany(
      { _id: { $in: payoutNameIds } },
      { $set: { paymentStatus: 'paid', amount: 0, maturityDate: null, paymentReceivedDate: null } }
    );
    
    // Update Client Accumulators
    await User.findByIdAndUpdate(clientId, {
      $inc: {
        totalPaidUSD: grossAmountUSD,
        totalFeesUSD: feeAmountUSD,
        totalProfitUSD: totalProfitUSD
      }
    });
    
    // Notify the client
    await Notification.create({
      recipient: clientId,
      type: 'payout',
      title: 'Payout Processed',
      message: `A batch payout of $${grossAmountUSD.toFixed(2)} was successfully processed.`,
      link: '/client/payouts'
    });

    const batchTeleMsg = telegramService.formatNotification({
      icon: "💸",
      title: "Batch Payout Processed",
      message: `A batch payout of <b>$${grossAmountUSD.toFixed(2)}</b> has been processed successfully.`,
      details: [
        { label: "Gross Amount", value: `$${grossAmountUSD.toFixed(2)}` },
        { label: "Fee Deducted", value: `$${feeAmountUSD.toFixed(2)}` },
        { label: "Net Payout", value: `$${netAmountUSD.toFixed(2)}` },
      ]
    });
    telegramService.sendToUser(clientId, batchTeleMsg).catch(() => {});

    res.status(200).json({
      success: true,
      message: "Batch payout executed successfully",
      data: transaction
    });

  } catch (error) {
    console.error("Payout error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getAllTransactions = async (req, res) => {
  try {
    const limit = req.query.limit === 'all' ? 0 : parseInt(req.query.limit) || 100;
    const query = PayoutTransaction.find({})
      .populate('clientId', 'profile.firstName profile.lastName email')
      .populate('adminId', 'firstName lastName email')
      .sort({ createdAt: -1 });
      
    if (limit > 0) {
      query.limit(limit);
    }
    
    const transactions = await query.exec();
      
    res.status(200).json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getClientTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    const query = { clientId: req.user.id };
    
    const total = await PayoutTransaction.countDocuments(query);
    const transactions = await PayoutTransaction.find(query)
      .populate('adminId', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
      
    res.status(200).json({
      success: true,
      data: {
        data: transactions,
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

module.exports = {
  getAdmins,
  getClientsByAdmin,
  getClientMaturedNames,
  getAdminMaturedStats,
  executeBatchPayout,
  getAllTransactions,
  getClientTransactions
};
