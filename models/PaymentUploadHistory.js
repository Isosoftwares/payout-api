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
  errors: [{
    rowNum: Number,
    name: String,
    amount: String,
    date: String,
    reason: String
  }]
},{
  timestamps: true,
});

module.exports = mongoose.model("PaymentUploadHistory", paymentUploadHistorySchema);
