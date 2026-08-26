const VirtualAccount = require('../models/VirtualAccount');
const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success, data, message, statusCode
});

const createVirtualAccount = async (req, res) => {
  try {
    const { firstName, lastName, identifier } = req.body;
    const virtualAccount = new VirtualAccount({
      client: req.user.id,
      firstName,
      lastName,
      identifier
    });
    await virtualAccount.save();
    res.status(201).json(formatResponse(true, virtualAccount, 'Virtual account created successfully', 201));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const getVirtualAccounts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const status = req.query.status || 'all';

    const filter = req.user.role === 'admin' ? {} : { client: req.user.id };
    
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { identifier: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status !== 'all') {
      filter.status = status;
    }

    const total = await VirtualAccount.countDocuments(filter);
    const accounts = await VirtualAccount.find(filter)
      .populate('client', 'profile email feePercentage')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
      
    res.status(200).json(formatResponse(true, {
      data: accounts,
      total,
      page,
      pages: Math.ceil(total / limit)
    }, 'Accounts fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const updateBankDetails = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    }
    const { id } = req.params;
    const { bankName, accountNumber, routingNumber, stripeAccountId } = req.body;
    
    const account = await VirtualAccount.findById(id);
    if (!account) return res.status(404).json(formatResponse(false, null, 'Account not found', 404));
    
    account.bankDetails = { bankName, accountNumber, routingNumber };
    if (stripeAccountId) account.stripeAccountId = stripeAccountId;
    account.status = 'active';
    
    await account.save();
    res.status(200).json(formatResponse(true, account, 'Bank details updated successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

module.exports = {
  createVirtualAccount,
  getVirtualAccounts,
  updateBankDetails
};
