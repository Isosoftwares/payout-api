const mongoose = require("mongoose");

const payoutNameSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true,
    unique: true
  },
  nameLower: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  routingNumber: { 
    type: String, 
    required: true 
  },
  accountNumber: { 
    type: String, 
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ["available", "allocated", "claimed"],
    default: "available"
  },
  allocatedTo: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User",
    default: null
  },
  claimedForSubaccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Subaccount",
    default: null
  },
  paymentStatus: {
    type: String,
    enum: ["not_received", "received", "matured", "paid"],
    default: "not_received"
  },
  amount: {
    type: Number,
    default: 0
  },
  paymentReceivedDate: {
    type: Date,
    default: null
  },
  maturityDate: {
    type: Date,
    default: null
  },
},{
  timestamps: true,
});

payoutNameSchema.pre("save", function (next) {
  if (this.isModified("name")) {
    this.nameLower = this.name.toLowerCase();
  }
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("PayoutName", payoutNameSchema);
