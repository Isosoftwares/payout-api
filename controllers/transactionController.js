const Transaction = require('../models/Transaction');
const VirtualAccount = require('../models/VirtualAccount');
const PayoutRequest = require('../models/PayoutRequest');
const FeeLog = require('../models/FeeLog');
const User = require('../models/User');
const Notification = require('../models/Notification');

const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success, data, message, statusCode
});

const recordDeposit = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    
    const { virtualAccountId, grossAmount, reference } = req.body;
    const account = await VirtualAccount.findById(virtualAccountId).populate('client');
    
    if (!account) return res.status(404).json(formatResponse(false, null, 'Account not found', 404));
    
    const parsedGrossAmount = parseFloat(grossAmount);
    
    if (isNaN(parsedGrossAmount) || parsedGrossAmount <= 0) {
      return res.status(400).json(formatResponse(false, null, 'Invalid amount', 400));
    }
    
    const feePercentage = account.client.feePercentage || 0;
    const feeAmount = (parsedGrossAmount * feePercentage) / 100;
    const netAmount = parsedGrossAmount - feeAmount;
    
    const transaction = new Transaction({
      virtualAccount: account._id,
      client: account.client._id,
      type: 'deposit',
      grossAmount: parsedGrossAmount,
      feeAmount,
      netAmount,
      reference
    });
    await transaction.save();
    
    const feeLog = new FeeLog({
      client: account.client._id,
      virtualAccount: account._id,
      transaction: transaction._id,
      feeAmount,
      grossAmount
    });
    await feeLog.save();
    
    account.balance += parsedGrossAmount;
    account.withdrawableBalance += netAmount;
    await account.save();
    
    await Notification.create({
      recipient: account.client._id,
      type: 'deposit',
      title: 'New Deposit Received',
      message: `A deposit of $${parsedGrossAmount.toFixed(2)} was recorded for ${account.firstName} ${account.lastName}.`
    });
    
    res.status(201).json(formatResponse(true, transaction, 'Deposit recorded successfully', 201));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const createPayoutRequest = async (req, res) => {
  try {
    const { virtualAccountId, amount } = req.body;
    const account = await VirtualAccount.findById(virtualAccountId);
    
    if (!account) return res.status(404).json(formatResponse(false, null, 'Account not found', 404));
    if (account.client.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    }
    
    if (amount > account.withdrawableBalance) {
      return res.status(400).json(formatResponse(false, null, 'Insufficient withdrawable balance', 400));
    }
    
    const payoutRequest = new PayoutRequest({
      virtualAccount: account._id,
      client: account.client,
      amount
    });
    await payoutRequest.save();
    
    res.status(201).json(formatResponse(true, payoutRequest, 'Payout requested successfully', 201));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const getPayoutRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    const filter = req.user.role === 'admin' ? {} : { client: req.user.id };
    const total = await PayoutRequest.countDocuments(filter);
    
    const requests = await PayoutRequest.find(filter)
      .populate('virtualAccount')
      .populate('client', 'email profile')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
      
    res.status(200).json(formatResponse(true, {
      data: requests,
      total,
      page,
      pages: Math.ceil(total / limit)
    }, 'Payout requests fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const updatePayoutRequest = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    const { id } = req.params;
    const { expectedDate, status } = req.body;
    
    const request = await PayoutRequest.findById(id);
    if (!request) return res.status(404).json(formatResponse(false, null, 'Request not found', 404));
    
    if (expectedDate) request.expectedDate = expectedDate;
    if (status) request.status = status;
    
    await request.save();
    res.status(200).json(formatResponse(true, request, 'Payout request updated successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const recordPayout = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    const { virtualAccountId, amount, reference, payoutRequestId } = req.body;
    
    const account = await VirtualAccount.findById(virtualAccountId);
    if (!account) return res.status(404).json(formatResponse(false, null, 'Account not found', 404));
    
    const parsedAmount = parseFloat(amount);
    
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json(formatResponse(false, null, 'Invalid amount', 400));
    }
    
    if (parsedAmount > account.withdrawableBalance) {
      return res.status(400).json(formatResponse(false, null, 'Insufficient withdrawable balance', 400));
    }
    
    const transaction = new Transaction({
      virtualAccount: account._id,
      client: account.client,
      type: 'payout',
      grossAmount: parsedAmount,
      feeAmount: 0,
      netAmount: parsedAmount,
      reference
    });
    await transaction.save();
    
    // Deduct proportionally from gross balance so fees don't endlessly accumulate
    const proportion = parsedAmount / account.withdrawableBalance;
    const grossToDeduct = account.balance * proportion;

    account.withdrawableBalance -= parsedAmount;
    account.balance -= grossToDeduct; 

    // Eliminate floating point residue
    if (account.withdrawableBalance <= 0.01) {
      account.withdrawableBalance = 0;
      account.balance = 0;
    } 
    await account.save();
    
    if (payoutRequestId) {
      await PayoutRequest.findByIdAndUpdate(payoutRequestId, { status: 'completed' });
    }
    
    await Notification.create({
      recipient: account.client,
      type: 'payout',
      title: 'Payout Processed',
      message: `A payout of $${parsedAmount.toFixed(2)} was completed for ${account.firstName} ${account.lastName}.`
    });
    
    res.status(201).json(formatResponse(true, transaction, 'Payout recorded successfully', 201));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const getFeeLedger = async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    
    // Using aggregation to sort by daily, weekly, monthly and per client
    const fees = await FeeLog.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'client',
          foreignField: '_id',
          as: 'clientObj'
        }
      },
      { $unwind: '$clientObj' },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            week: { $isoWeek: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
            client: '$clientObj.email'
          },
          totalFee: { $sum: '$feeAmount' },
          totalGross: { $sum: '$grossAmount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1, '_id.day': -1 } }
    ]);
    
    res.status(200).json(formatResponse(true, fees, 'Fee ledger fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    
    const filter = req.user.role === 'admin' ? {} : { client: req.user.id };
    const total = await Transaction.countDocuments(filter);
    
    const transactions = await Transaction.find(filter)
      .populate('virtualAccount')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
      
    res.status(200).json(formatResponse(true, {
      data: transactions,
      total,
      page,
      pages: Math.ceil(total / limit)
    }, 'Transactions fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

module.exports = {
  recordDeposit,
  createPayoutRequest,
  getPayoutRequests,
  updatePayoutRequest,
  recordPayout,
  getFeeLedger,
  getTransactions
};
