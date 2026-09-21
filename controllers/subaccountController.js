const Subaccount = require('../models/Subaccount');
const User = require('../models/User');
const PayoutName = require('../models/PayoutName');
const bcrypt = require('bcryptjs');

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success,
  data,
  message,
  statusCode
});

// @desc    Create a new subaccount
// @route   POST /api/subaccounts
// @access  Private (Client / Admin)
const createSubaccount = asyncHandler(async (req, res) => {
  let clientId = req.user.id;
  if (req.user.role === 'admin') {
    if (!req.body.clientId) {
      const response = formatResponse(false, null, 'Client ID is required when creating a subaccount as admin', 400);
      return res.status(response.statusCode).json(response);
    }
    const clientUser = await User.findById(req.body.clientId);
    if (!clientUser) {
      const response = formatResponse(false, null, 'Client not found', 404);
      return res.status(response.statusCode).json(response);
    }
    clientId = req.body.clientId;
  }

  const { username, password } = req.body;

  if (!username || !password) {
    const response = formatResponse(false, null, 'Username and password are required', 400);
    return res.status(response.statusCode).json(response);
  }

  if (username.toLowerCase() === 'self') {
    const response = formatResponse(false, null, 'The username "self" is reserved and cannot be used', 400);
    return res.status(response.statusCode).json(response);
  }

  if (password.length < 6) {
    const response = formatResponse(false, null, 'Password must be at least 6 characters long', 400);
    return res.status(response.statusCode).json(response);
  }

  const existingSubaccount = await Subaccount.findOne({ username: username.toLowerCase() });
  if (existingSubaccount) {
    const response = formatResponse(false, null, 'A subaccount with this username already exists', 409);
    return res.status(response.statusCode).json(response);
  }

  const existingUser = await User.findOne({ email: username.toLowerCase() });
  if (existingUser) {
    const response = formatResponse(false, null, 'Username is already taken by a user email', 409);
    return res.status(response.statusCode).json(response);
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const subaccount = await Subaccount.create({
    username: username.toLowerCase(),
    password: hashedPassword,
    clientId
  });

  const subaccountResponse = subaccount.toObject();
  delete subaccountResponse.password;

  const response = formatResponse(true, subaccountResponse, 'Subaccount created successfully', 201);
  res.status(response.statusCode).json(response);
});

// @desc    Get all subaccounts for a client
// @route   GET /api/subaccounts
// @access  Private (Client / Admin)
const getSubaccounts = asyncHandler(async (req, res) => {
  let clientId = req.user.id;
  if (req.user.role === 'admin' && req.query.clientId) {
    clientId = req.query.clientId;
  }

  const subaccounts = await Subaccount.find({ clientId }).select('-password').sort({ createdAt: -1 });

  const subaccountsWithCounts = await Promise.all(
    subaccounts.map(async (sub) => {
      const claimedCount = await PayoutName.countDocuments({
        claimedForSubaccount: sub._id,
        status: 'claimed'
      });
      const subObj = sub.toObject();
      subObj.claimedCount = claimedCount;
      return subObj;
    })
  );

  const response = formatResponse(true, subaccountsWithCounts);
  res.status(response.statusCode).json(response);
});

// @desc    Delete a subaccount
// @route   DELETE /api/subaccounts/:id
// @access  Private (Client / Admin)
const deleteSubaccount = asyncHandler(async (req, res) => {
  let subaccount;
  if (req.user.role === 'admin') {
    subaccount = await Subaccount.findById(req.params.id);
  } else {
    subaccount = await Subaccount.findOne({ _id: req.params.id, clientId: req.user.id });
  }

  if (!subaccount) {
    const response = formatResponse(false, null, 'Subaccount not found', 404);
    return res.status(response.statusCode).json(response);
  }

  await subaccount.deleteOne();
  
  // Reset claimed names assigned to this subaccount back to "self" (null)
  await PayoutName.updateMany(
    { claimedForSubaccount: subaccount._id },
    { $set: { claimedForSubaccount: null } }
  );

  const response = formatResponse(true, null, 'Subaccount deleted successfully');
  res.status(response.statusCode).json(response);
});

module.exports = {
  createSubaccount,
  getSubaccounts,
  deleteSubaccount
};
