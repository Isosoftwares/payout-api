const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: "VirtualAccount", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["deposit", "payout"], required: true },
  grossAmount: { type: Number, required: true },
  feeAmount: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  reference: { type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Transaction", transactionSchema);
