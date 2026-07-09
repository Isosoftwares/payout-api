const mongoose = require("mongoose");

const virtualAccountSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  identifier: { type: String },
  stripeAccountId: { type: String },
  bankDetails: {
    bankName: String,
    accountNumber: String,
    routingNumber: String,
  },
  balance: { type: Number, default: 0 },
  withdrawableBalance: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["pending_bank_details", "active"],
    default: "pending_bank_details",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

virtualAccountSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("VirtualAccount", virtualAccountSchema);
