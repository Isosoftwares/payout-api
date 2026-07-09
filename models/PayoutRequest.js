const mongoose = require("mongoose");

const payoutRequestSchema = new mongoose.Schema({
  virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: "VirtualAccount", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  expectedDate: { type: Date },
  status: {
    type: String,
    enum: ["pending", "processing", "completed", "rejected"],
    default: "pending",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

payoutRequestSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("PayoutRequest", payoutRequestSchema);
