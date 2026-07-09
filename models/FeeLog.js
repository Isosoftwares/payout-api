const mongoose = require("mongoose");

const feeLogSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: "VirtualAccount" },
  transaction: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
  feeAmount: { type: Number, required: true },
  grossAmount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("FeeLog", feeLogSchema);
