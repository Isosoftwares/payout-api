const mongoose = require("mongoose");

const paymentUploadHistorySchema = new mongoose.Schema({
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  totalProcessed: {
    type: Number,
    default: 0
  },
  totalMatched: {
    type: Number,
    default: 0
  },
  items: [{
    rowNum: Number,
    name: String,
    amount: String,
    date: String,
    status: {
      type: String,
      enum: ["Success", "Failed"],
      default: "Success"
    },
    claimedBy: String,
    reason: String
  }],
  errors: [{
    rowNum: Number,
    name: String,
    amount: String,
    date: String,
    reason: String
  }],
  isReversed: {
    type: Boolean,
    default: false,
    index: true
  },
  reversedAt: {
    type: Date,
    default: null
  },
  reversedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  reversalReason: {
    type: String,
    default: null
  },
  reversalSummary: {
    reversedCount: Number,
    totalReversedAmount: Number
  }
},{
  timestamps: true,
  suppressReservedKeysWarning: true
});

module.exports = mongoose.model("PaymentUploadHistory", paymentUploadHistorySchema);
