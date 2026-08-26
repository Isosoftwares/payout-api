const mongoose = require("mongoose");

const payoutTransactionSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  payoutNames: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "PayoutName"
  }],
  grossAmountUSD: {
    type: Number,
    required: true
  },
  feePercentage: {
    type: Number,
    required: true
  },
  feeAmountUSD: {
    type: Number,
    required: true
  },
  netAmountUSD: {
    type: Number,
    required: true
  },
  payoutCurrency: {
    type: String,
    enum: ['USD', 'KES'],
    required: true
  },
  exchangeRateBuy: {
    type: Number,
    required: true
  },
  exchangeRateSell: {
    type: Number,
    required: true
  },
  finalPayoutAmount: {
    type: Number,
    required: true
  },
  spreadProfitUSD: {
    type: Number,
    default: 0
  },
  totalProfitUSD: {
    type: Number,
    required: true
  },
  paymentMethodId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PaymentMethod", // Assuming this is the bank details model
  },
  referenceId: {
    type: String,
  },
  status: {
    type: String,
    enum: ['completed', 'failed'],
    default: 'completed'
  }
},{
  timestamps: true,
});

module.exports = mongoose.model("PayoutTransaction", payoutTransactionSchema);
