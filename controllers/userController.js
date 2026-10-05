// controllers/userController.js
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const bcrypt = require('bcryptjs');

// Error handling wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Response formatter
const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success,
  data,
  message,
  statusCode
});

// Pure function for user validation
const validateUserData = (userData, isUpdate = false) => {
  const errors = [];
  
  if (!isUpdate || userData.email) {
    if (!userData.email) {
      errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userData.email)) {
      errors.push('Valid email is required');
    }
  }
  
  if (!isUpdate || userData.password) {
    if (!userData.password) {
      errors.push('Password is required');
    } else if (userData.password.length < 6) {
      errors.push('Password must be at least 6 characters long');
    }
  }
  
  if (!isUpdate || userData.role) {
    if (!userData.role) {
      errors.push('Role is required');
    } else if (!['admin', 'client'].includes(userData.role)) {
      errors.push('Role must be either admin or client');
    }
  }
  
  if (userData.balance !== undefined && userData.balance < 0) {
    errors.push('Balance cannot be negative');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// Pure function for password validation
const validatePassword = (password) => {
  const errors = [];
  
  if (!password) {
    errors.push('Password is required');
  } else {
    if (password.length < 6) {
      errors.push('Password must be at least 6 characters long');
    }
    if (!/(?=.*[a-z])/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    if (!/(?=.*[A-Z])/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    if (!/(?=.*\d)/.test(password)) {
      errors.push('Password must contain at least one number');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

// ================================
// ADMIN USER MANAGEMENT
// ================================

// Get all users with pagination and filters
const getAllUsers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    role,
    isActive,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;
  
  // Build filter object
  const filter = {};
  
  if (role) {
    filter.role = role;
  }
  
  if (isActive !== undefined) {
    filter.isActive = isActive === 'true';
  }
  
  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: 'i' } },
      { 'profile.firstName': { $regex: search, $options: 'i' } },
      { 'profile.lastName': { $regex: search, $options: 'i' } },
      { 'profile.company': { $regex: search, $options: 'i' } }
    ];
  }
  
  // Build sort object
  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
  
  // Execute query with pagination
  const options = {
    page: parseInt(page),
    limit: parseInt(limit)
  };
  
  const users = await User.find(filter)
    .select('-password')
    .sort(sort)
    .limit(options.limit * 1)
    .skip((options.page - 1) * options.limit);
  
  const total = await User.countDocuments(filter);
  
  const response = formatResponse(true, {
    users,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      pages: Math.ceil(total / options.limit)
    }
  });
  
  res.status(response.statusCode).json(response);
});

// Get user by ID
const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .select('-password')
    .populate('createdBy', 'profile.firstName profile.lastName email');
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  // Get user statistics from Transactions
  const stats = await Transaction.aggregate([
    { $match: { client: user._id } },
    {
      $group: {
        _id: null,
        totalRequests: { $sum: 1 },
        totalSpent: { $sum: '$grossAmount' }, // Replace as needed
        lastActivity: { $max: '$createdAt' }
      }
    }
  ]);

  const PayoutName = require('../models/PayoutName');
  const PayoutNameLog = require('../models/PayoutNameLog');
  const myNames = await PayoutName.find({ allocatedTo: user._id });

  let totalReceivedUSD = 0;
  let totalMaturedUSD = 0;
  let namesWithBalanceCount = 0;

  myNames.forEach(name => {
    const amt = name.amount || 0;
    if (amt > 0) namesWithBalanceCount++;
    if (name.paymentStatus === 'received') {
      totalReceivedUSD += amt;
    } else if (name.paymentStatus === 'matured') {
      totalMaturedUSD += amt;
    }
  });

  const myNameIds = myNames.map(n => n._id);
  let multiPaymentNamesCount = 0;
  if (myNameIds.length > 0) {
    try {
      const multiAgg = await PayoutNameLog.aggregate([
        {
          $match: {
            payoutName: { $in: myNameIds },
            action: 'payment_received'
          }
        },
        {
          $group: {
            _id: "$payoutName",
            count: { $sum: 1 }
          }
        },
        {
          $match: { count: { $gt: 1 } }
        }
      ]);
      multiPaymentNamesCount = multiAgg.length;
    } catch (e) {
      console.error('Error calculating multi-payment names:', e);
    }
  }

  const PayoutTransaction = require('../models/PayoutTransaction');
  const profitStats = await PayoutTransaction.aggregate([
    { $match: { clientId: user._id, status: 'completed' } },
    {
      $group: {
        _id: null,
        totalProfitUSD: { $sum: '$totalProfitUSD' },
        totalPaidUSD: { $sum: '$grossAmountUSD' },
        totalFeesUSD: { $sum: '$feeAmountUSD' }
      }
    }
  ]);

  const totalPaidGrossUSD = profitStats[0]?.totalPaidUSD || 0;
  const totalFeesUSD = profitStats[0]?.totalFeesUSD || 0;
  const totalNetPaidUSD = totalPaidGrossUSD - totalFeesUSD;
  const totalUnpaidUSD = totalReceivedUSD + totalMaturedUSD;
  const allTimeGrossUSD = totalUnpaidUSD + totalPaidGrossUSD;
  
  const userData = {
    ...user.toObject(),
    statistics: stats[0] || {
      totalRequests: 0,
      totalSpent: 0,
      lastActivity: null
    },
    totalProfitUSD: profitStats[0]?.totalProfitUSD || 0,
    totalPaidUSD: totalPaidGrossUSD,
    totalPaidGrossUSD,
    totalFeesUSD,
    totalNetPaidUSD,
    totalReceivedUSD,
    totalMaturedUSD,
    unmaturedBalanceUSD: totalReceivedUSD,
    maturedBalanceUSD: totalMaturedUSD,
    totalUnpaidUSD,
    allTimeGrossUSD,
    namesWithBalanceCount,
    multiPaymentNamesCount,
    totalClaimedNamesCount: myNames.filter(n => n.status === 'claimed').length,
    totalAllocatedNamesCount: myNames.filter(n => n.status === 'allocated').length,
  };
  
  const response = formatResponse(true, userData);
  res.status(response.statusCode).json(response);
});

// Create new user
const createUser = asyncHandler(async (req, res) => {
  const validation = validateUserData(req.body);
  
  if (!validation.isValid) {
    const response = formatResponse(false, null, validation.errors.join(', '), 400);
    return res.status(response.statusCode).json(response);
  }
  
  // Check if user already exists
  const existingUser = await User.findOne({ email: req.body.email.trim().toLowerCase() });
  if (existingUser) {
    const response = formatResponse(false, null, 'User with this email already exists', 409);
    return res.status(response.statusCode).json(response);
  }
  
  // Hash password
  const hashedPassword = await bcrypt.hash(req.body.password, 12);
  
  // Create user
  const userData = {
    ...req.body,
    password: hashedPassword,
    mustChangePassword: true, // Force password change for admin-created accounts
    feePercentage: req.body.feePercentage || 0,
    usdBuyPrice: req.body.usdBuyPrice || 0,
    usdSellPrice: req.body.usdSellPrice || 0,
    createdBy: req.user.id,
  };
  
  const user = new User(userData);
  await user.save();
  
  // Remove password from response
  const userResponse = user.toObject();
  delete userResponse.password;
  
  const response = formatResponse(true, userResponse, 'User created successfully', 201);
  res.status(response.statusCode).json(response);
});

// Update user
const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  // Validate update data
  const validation = validateUserData(req.body, true);
  
  if (!validation.isValid) {
    const response = formatResponse(false, null, validation.errors.join(', '), 400);
    return res.status(response.statusCode).json(response);
  }
  
  // Check if email is being changed and if it already exists
  if (req.body.email && req.body.email !== user.email) {
    const existingUser = await User.findOne({ email: req.body.email });
    if (existingUser) {
      const response = formatResponse(false, null, 'Email already exists', 409);
      return res.status(response.statusCode).json(response);
    }
  }
  
  // Hash password if provided
  if (req.body.password) {
    req.body.password = await bcrypt.hash(req.body.password, 12);
  }
  
  if (req.body.telegramUsername !== undefined) {
    let cleanUsername = (req.body.telegramUsername || '').trim();
    if (cleanUsername.startsWith('@')) {
      cleanUsername = cleanUsername.substring(1);
    }
    req.body.telegramUsername = cleanUsername || null;
  }

  // Update user
  Object.assign(user, req.body);
  await user.save();
  
  // Remove password from response
  const userResponse = user.toObject();
  delete userResponse.password;
  
  const response = formatResponse(true, userResponse, 'User updated successfully');
  res.status(response.statusCode).json(response);
});

// Delete user with guardrails for payout names
const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  // Prevent deleting the last admin
  if (user.role === 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin', isActive: true });
    if (adminCount <= 1) {
      const response = formatResponse(false, null, 'Cannot delete the last admin user', 400);
      return res.status(response.statusCode).json(response);
    }
  }

  const PayoutName = require('../models/PayoutName');

  // Guardrail 1: Claimed names check
  const claimedCount = await PayoutName.countDocuments({
    allocatedTo: user._id,
    status: 'claimed'
  });
  if (claimedCount > 0) {
    const response = formatResponse(
      false, 
      null, 
      `Client cannot be deleted because they have ${claimedCount} claimed payout name(s). Clients with claimed names cannot be deleted, but can be suspended.`, 
      400
    );
    return res.status(response.statusCode).json(response);
  }

  // Guardrail 2: Allocated (unclaimed) names check
  const allocatedCount = await PayoutName.countDocuments({
    allocatedTo: user._id,
    status: 'allocated'
  });
  if (allocatedCount > 0) {
    const response = formatResponse(
      false, 
      null, 
      `Client cannot be deleted because they have ${allocatedCount} allocated payout name(s). All allocated names must be de-allocated before deleting this client.`, 
      400
    );
    return res.status(response.statusCode).json(response);
  }

  // Safe to delete: clean up client subaccounts and requests
  const Subaccount = require('../models/Subaccount');
  const AllocationRequest = require('../models/AllocationRequest');
  const SpecificNameRequest = require('../models/SpecificNameRequest');

  await Subaccount.deleteMany({ clientId: user._id });
  await AllocationRequest.deleteMany({ client: user._id });
  await SpecificNameRequest.deleteMany({ client: user._id });
  await user.deleteOne();
  
  const response = formatResponse(true, null, 'Client and associated records deleted successfully');
  res.status(response.statusCode).json(response);
});

// Admin resets client password to 123456
const resetUserPassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const hashedPassword = await bcrypt.hash('123456', 12);
  user.password = hashedPassword;
  user.mustChangePassword = true;
  await user.save();

  const response = formatResponse(true, null, 'Client password has been reset to 123456');
  res.status(response.statusCode).json(response);
});

// Admin toggles suspension of client
const toggleSuspendUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }

  if (user.role === 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin', isActive: true });
    if (adminCount <= 1 && user.isActive) {
      const response = formatResponse(false, null, 'Cannot suspend the last active admin', 400);
      return res.status(response.statusCode).json(response);
    }
  }

  // Toggle suspension state
  const willBeSuspended = user.isSuspended ? false : true;
  user.isSuspended = willBeSuspended;
  user.isActive = !willBeSuspended;
  await user.save();

  const actionText = willBeSuspended ? 'suspended' : 'activated';
  const response = formatResponse(
    true, 
    { isActive: user.isActive, isSuspended: user.isSuspended }, 
    `Client has been ${actionText} successfully`
  );
  res.status(response.statusCode).json(response);
});

// Add balance to user
const addBalance = asyncHandler(async (req, res) => {
  const { amount, description } = req.body;
  
  if (!amount || amount <= 0) {
    const response = formatResponse(false, null, 'Valid amount is required', 400);
    return res.status(response.statusCode).json(response);
  }
  
  const user = await User.findById(req.params.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  if (user.role !== 'client') {
    const response = formatResponse(false, null, 'Balance can only be added to client accounts', 400);
    return res.status(response.statusCode).json(response);
  }
  
  const oldBalance = user.balance;
  user.balance += parseFloat(amount);
  await user.save();
  
  const response = formatResponse(true, {
    userId: user._id,
    oldBalance,
    newBalance: user.balance,
    amountAdded: parseFloat(amount),
    description: description || 'Balance added by admin'
  }, 'Balance added successfully');
  
  res.status(response.statusCode).json(response);
});

// Get user statistics
const getUserStatistics = asyncHandler(async (req, res) => {
  const stats = await User.aggregate([
    {
      $group: {
        _id: null,
        totalUsers: { $sum: 1 },
        activeUsers: { $sum: { $cond: ['$isActive', 1, 0] } },
        adminUsers: { $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
        clientUsers: { $sum: { $cond: [{ $eq: ['$role', 'client'] }, 1, 0] } },
        totalBalance: { $sum: '$balance' },
        averageBalance: { $avg: '$balance' }
      }
    }
  ]);
  
  // Get recent registrations
  const recentUsers = await User.find({ isActive: true })
    .select('email role createdAt profile.firstName profile.lastName')
    .sort({ createdAt: -1 })
    .limit(5);
  
  const result = {
    overview: stats[0] || {
      totalUsers: 0,
      activeUsers: 0,
      adminUsers: 0,
      clientUsers: 0,
      totalBalance: 0,
      averageBalance: 0
    },
    recentUsers
  };
  
  const response = formatResponse(true, result);
  res.status(response.statusCode).json(response);
});

// ================================
// USER PROFILE MANAGEMENT
// ================================

// Get own profile
const getOwnProfile = asyncHandler(async (req, res) => {

  const user = await User.findById(req.user.id).select('-password');
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const response = formatResponse(true, user);
  res.status(response.statusCode).json(response);
});

// Update own profile
const updateOwnProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const updateData = {};
  
  // Handle nested profile updates
  if (req.body.profile) {
    updateData.profile = { ...user.profile, ...req.body.profile };
  }

  // Handle Telegram username
  if (req.body.telegramUsername !== undefined) {
    let cleanUsername = (req.body.telegramUsername || '').trim();
    if (cleanUsername.startsWith('@')) {
      cleanUsername = cleanUsername.substring(1);
    }
    updateData.telegramUsername = cleanUsername || null;
    // If username changed and not empty, but chat ID not yet connected, user will connect via bot
  }

  // Handle Telegram notification toggle
  if (req.body.telegramNotificationsEnabled !== undefined) {
    updateData.telegramNotificationsEnabled = Boolean(req.body.telegramNotificationsEnabled);
  }
  
  // Update user
  Object.assign(user, updateData);
  await user.save();
  
  // Remove password from response
  const userResponse = user.toObject();
  delete userResponse.password;
  
  const response = formatResponse(true, userResponse, 'Profile updated successfully');
  res.status(response.statusCode).json(response);
});

// Get Telegram Bot Info and Connection Status
const getTelegramBotInfo = asyncHandler(async (req, res) => {
  const telegramService = require('../services/telegramService');
  const user = await User.findById(req.user.id).select('telegramUsername telegramChatId telegramNotificationsEnabled');
  
  const botUsername = telegramService.botUsername || process.env.TELEGRAM_BOT_USERNAME || null;
  const isConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);

  res.status(200).json(formatResponse(true, {
    botUsername,
    isConfigured,
    telegramUsername: user?.telegramUsername || null,
    isConnected: Boolean(user?.telegramChatId),
    telegramNotificationsEnabled: user?.telegramNotificationsEnabled !== false,
    connectUrl: botUsername ? `https://t.me/${botUsername}?start=${req.user.id}` : null
  }));
});

// Send Test Telegram Notification
const testTelegramNotification = asyncHandler(async (req, res) => {
  const telegramService = require('../services/telegramService');
  try {
    await telegramService.sendTestMessage(req.user.id);
    res.status(200).json(formatResponse(true, null, 'Test notification sent successfully to your Telegram!'));
  } catch (error) {
    res.status(400).json(formatResponse(false, null, error.message || 'Failed to send test notification', 400));
  }
});

// Get own balance (for clients)
const getOwnBalance = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('balance');
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  if (user.role !== 'client') {
    const response = formatResponse(false, null, 'Balance is only available for client accounts', 400);
    return res.status(response.statusCode).json(response);
  }
  
  const response = formatResponse(true, { balance: user.balance });
  res.status(response.statusCode).json(response);
});

// Get Client Dashboard Stats
const getClientDashboardStats = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('feePercentage usdBuyPrice usdSellPrice paymentMethods');
  
  if (!user) {
    return res.status(404).json(formatResponse(false, null, 'User not found', 404));
  }

  const PayoutName = require('../models/PayoutName');
  const myNames = await PayoutName.find({ allocatedTo: req.user.id });

  let totalReceivedUSD = 0;
  let totalMaturedUSD = 0;
  let totalPaidUSD = 0;

  myNames.forEach(name => {
    const amt = name.amount || 0;
    if (name.paymentStatus === 'received') {
      totalReceivedUSD += amt;
    } else if (name.paymentStatus === 'matured') {
      totalMaturedUSD += amt;
    }
  });

  const PayoutTransaction = require('../models/PayoutTransaction');
  const paidStats = await PayoutTransaction.aggregate([
    { $match: { clientId: user._id, status: 'completed' } },
    {
      $group: {
        _id: null,
        totalPaidUSD: { $sum: '$grossAmountUSD' }
      }
    }
  ]);

  if (paidStats.length > 0) {
    totalPaidUSD = paidStats[0].totalPaidUSD;
  }

  res.status(200).json(formatResponse(true, {
    totalReceivedUSD,
    totalMaturedUSD,
    totalPaidUSD,
    feePercentage: user.feePercentage,
    usdBuyPrice: user.usdBuyPrice,
    usdSellPrice: user.usdSellPrice,
    paymentMethods: user.paymentMethods,
    totalNamesCount: myNames.length
  }));
});

// Add a payment method
const addPaymentMethod = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const { type, details } = req.body;
  
  if (!type || !['mpesa', 'bank', 'crypto'].includes(type)) {
    const response = formatResponse(false, null, 'Valid payment method type is required', 400);
    return res.status(response.statusCode).json(response);
  }
  
  if (!details || typeof details !== 'object') {
    const response = formatResponse(false, null, 'Valid payment details are required', 400);
    return res.status(response.statusCode).json(response);
  }
  
  // If it's the first payment method, make it default
  const isDefault = user.paymentMethods.length === 0;
  
  user.paymentMethods.push({
    type,
    details,
    isDefault
  });
  
  await user.save();
  
  const response = formatResponse(true, user.paymentMethods, 'Payment method added successfully');
  res.status(response.statusCode).json(response);
});

// Delete a payment method
const deletePaymentMethod = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const { methodId } = req.params;
  
  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );
  
  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const wasDefault = user.paymentMethods[methodIndex].isDefault;
  
  // Remove the payment method
  user.paymentMethods.splice(methodIndex, 1);
  
  // If we removed the default and there are other methods, make the first one default
  if (wasDefault && user.paymentMethods.length > 0) {
    user.paymentMethods[0].isDefault = true;
  }
  
  await user.save();
  
  const response = formatResponse(true, user.paymentMethods, 'Payment method deleted successfully');
  res.status(response.statusCode).json(response);
});

// Edit a payment method
const editPaymentMethod = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const { methodId } = req.params;
  const { type, details } = req.body;
  
  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );
  
  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }

  if (type) {
    if (!['mpesa', 'bank', 'crypto'].includes(type)) {
      const response = formatResponse(false, null, 'Valid payment method type is required', 400);
      return res.status(response.statusCode).json(response);
    }
    user.paymentMethods[methodIndex].type = type;
  }
  
  if (details && typeof details === 'object') {
    user.paymentMethods[methodIndex].details = details;
  }
  
  await user.save();
  
  const response = formatResponse(true, user.paymentMethods, 'Payment method updated successfully');
  res.status(response.statusCode).json(response);
});

// Set a payment method as default
const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  
  if (!user) {
    const response = formatResponse(false, null, 'User not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  const { methodId } = req.params;
  
  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );
  
  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }
  
  // Set all to false
  user.paymentMethods.forEach(method => {
    method.isDefault = false;
  });
  
  // Set selected to true
  user.paymentMethods[methodIndex].isDefault = true;
  
  await user.save();
  
  const response = formatResponse(true, user.paymentMethods, 'Default payment method updated');
  res.status(response.statusCode).json(response);
});

// ================================
// ADMIN CLIENT PAYMENT METHODS
// ================================

// Admin adds a payment method for a client
const addClientPaymentMethod = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await User.findById(id);

  if (!user) {
    const response = formatResponse(false, null, 'Client not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const { type, details, isDefault } = req.body;

  if (!type || !['mpesa', 'bank', 'crypto'].includes(type)) {
    const response = formatResponse(false, null, 'Valid payment method type is required (mpesa, bank, crypto)', 400);
    return res.status(response.statusCode).json(response);
  }

  if (!details || typeof details !== 'object') {
    const response = formatResponse(false, null, 'Valid payment details are required', 400);
    return res.status(response.statusCode).json(response);
  }

  const makeDefault = Boolean(isDefault) || user.paymentMethods.length === 0;

  if (makeDefault) {
    user.paymentMethods.forEach(method => {
      method.isDefault = false;
    });
  }

  user.paymentMethods.push({
    type,
    details,
    isDefault: makeDefault
  });

  await user.save();

  const response = formatResponse(true, user.paymentMethods, 'Payment method added successfully');
  res.status(response.statusCode).json(response);
});

// Admin edits a client payment method
const editClientPaymentMethod = asyncHandler(async (req, res) => {
  const { id, methodId } = req.params;
  const user = await User.findById(id);

  if (!user) {
    const response = formatResponse(false, null, 'Client not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const { type, details, isDefault } = req.body;

  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );

  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }

  if (type) {
    if (!['mpesa', 'bank', 'crypto'].includes(type)) {
      const response = formatResponse(false, null, 'Valid payment method type is required', 400);
      return res.status(response.statusCode).json(response);
    }
    user.paymentMethods[methodIndex].type = type;
  }

  if (details && typeof details === 'object') {
    user.paymentMethods[methodIndex].details = details;
  }

  if (isDefault !== undefined) {
    if (isDefault) {
      user.paymentMethods.forEach(m => { m.isDefault = false; });
      user.paymentMethods[methodIndex].isDefault = true;
    } else {
      user.paymentMethods[methodIndex].isDefault = false;
    }
  }

  await user.save();

  const response = formatResponse(true, user.paymentMethods, 'Payment method updated successfully');
  res.status(response.statusCode).json(response);
});

// Admin deletes a client payment method
const deleteClientPaymentMethod = asyncHandler(async (req, res) => {
  const { id, methodId } = req.params;
  const user = await User.findById(id);

  if (!user) {
    const response = formatResponse(false, null, 'Client not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );

  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const wasDefault = user.paymentMethods[methodIndex].isDefault;

  user.paymentMethods.splice(methodIndex, 1);

  if (wasDefault && user.paymentMethods.length > 0) {
    user.paymentMethods[0].isDefault = true;
  }

  await user.save();

  const response = formatResponse(true, user.paymentMethods, 'Payment method deleted successfully');
  res.status(response.statusCode).json(response);
});

// Admin sets a client payment method as default
const setDefaultClientPaymentMethod = asyncHandler(async (req, res) => {
  const { id, methodId } = req.params;
  const user = await User.findById(id);

  if (!user) {
    const response = formatResponse(false, null, 'Client not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const methodIndex = user.paymentMethods.findIndex(
    method => method._id.toString() === methodId
  );

  if (methodIndex === -1) {
    const response = formatResponse(false, null, 'Payment method not found', 404);
    return res.status(response.statusCode).json(response);
  }

  user.paymentMethods.forEach(method => {
    method.isDefault = false;
  });

  user.paymentMethods[methodIndex].isDefault = true;

  await user.save();

  const response = formatResponse(true, user.paymentMethods, 'Default payment method updated');
  res.status(response.statusCode).json(response);
});

// @desc    Get complete itemized payment history & ledger for a client
// @route   GET /api/users/:id/payment-history
// @access  Private/Admin
const getClientPaymentHistory = asyncHandler(async (req, res) => {
  const clientId = req.params.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const isExport = req.query.all === 'true' || req.query.download === 'true';
  const limit = isExport ? 10000 : Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
  const search = req.query.search?.trim() || '';
  const status = req.query.status || 'all';

  const client = await User.findById(clientId);
  if (!client) {
    const response = formatResponse(false, null, 'Client not found', 404);
    return res.status(response.statusCode).json(response);
  }

  const PaymentRecord = require('../models/PaymentRecord');
  const prCount = await PaymentRecord.countDocuments({ allocatedTo: clientId });

  if (prCount > 0) {
    const query = { allocatedTo: clientId };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { accountNumber: { $regex: search, $options: 'i' } },
        { routingNumber: { $regex: search, $options: 'i' } },
      ];
    }
    if (status !== 'all') {
      if (status === 'reversed') {
        query.isReversed = true;
      } else {
        query.paymentStatus = status;
        query.isReversed = { $ne: true };
      }
    }

    const total = await PaymentRecord.countDocuments(query);
    const records = await PaymentRecord.find(query)
      .populate('payoutName', 'name accountNumber routingNumber status paymentStatus amount')
      .populate('claimedForSubaccount', 'username')
      .sort({ paymentReceivedDate: -1, createdAt: -1 })
      .skip(isExport ? 0 : (page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      success: true,
      data: {
        records,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  }

  // Fallback to PayoutNameLog & PayoutName if no PaymentRecords exist yet
  const PayoutName = require('../models/PayoutName');
  const PayoutNameLog = require('../models/PayoutNameLog');

  const clientNames = await PayoutName.find({ allocatedTo: clientId }).populate('claimedForSubaccount', 'username');
  const nameMap = new Map();
  clientNames.forEach(n => nameMap.set(n._id.toString(), n));
  const nameIds = clientNames.map(n => n._id);

  const logs = await PayoutNameLog.find({
    payoutName: { $in: nameIds },
    action: { $in: ['payment_received', 'payment_reversed'] }
  }).sort({ timestamp: -1 });

  let mapped = logs.map(l => {
    const pn = nameMap.get(l.payoutName?.toString());
    const isRev = l.action === 'payment_reversed';
    return {
      _id: l._id,
      payoutName: pn,
      name: pn?.name || 'Unknown',
      accountNumber: pn?.accountNumber || '',
      routingNumber: pn?.routingNumber || '',
      claimedForSubaccount: pn?.claimedForSubaccount || null,
      amount: l.amount || 0,
      paymentReceivedDate: l.paymentDate || l.timestamp,
      maturityDate: l.maturityDate,
      paymentStatus: isRev ? 'reversed' : (l.paymentStatus || 'received'),
      isReversed: isRev,
      uploadFileName: l.narration || '',
      createdAt: l.timestamp,
    };
  });

  if (search) {
    const s = search.toLowerCase();
    mapped = mapped.filter(r =>
      r.name?.toLowerCase().includes(s) ||
      r.accountNumber?.includes(s) ||
      r.routingNumber?.includes(s)
    );
  }

  if (status !== 'all') {
    if (status === 'reversed') {
      mapped = mapped.filter(r => r.isReversed);
    } else {
      mapped = mapped.filter(r => !r.isReversed && r.paymentStatus === status);
    }
  }

  const total = mapped.length;
  const paginated = isExport ? mapped : mapped.slice((page - 1) * limit, page * limit);

  return res.status(200).json({
    success: true,
    data: {
      records: paginated,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  });
});

module.exports = {
  // Admin user management
  getAllUsers,
  getUserById,
  getClientPaymentHistory,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  toggleSuspendUser,
  addBalance,
  getUserStatistics,
  addClientPaymentMethod,
  editClientPaymentMethod,
  deleteClientPaymentMethod,
  setDefaultClientPaymentMethod,
  
  // User profile management
  getOwnProfile,
  updateOwnProfile,
  getOwnBalance,
  addPaymentMethod,
  deletePaymentMethod,
  editPaymentMethod,
  setDefaultPaymentMethod,
  getClientDashboardStats,
  getTelegramBotInfo,
  testTelegramNotification
};