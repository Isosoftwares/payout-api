const mongoose = require("mongoose");

const payoutNameLogSchema = new mongoose.Schema(
  {
    payoutName: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutName",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "created",
        "allocated",
        "claimed",
        "payment_received",
        "matured",
        "paid",
        "narration_note",
        "status_change",
        "other",
      ],
      required: true,
    },
    amount: {
      type: Number,
      default: null,
    },
    paymentStatus: {
      type: String,
      default: null,
    },
    paymentDate: {
      type: Date,
      default: null,
    },
    maturityDate: {
      type: Date,
      default: null,
    },
    narration: {
      type: String,
      default: "",
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    performedByRole: {
      type: String,
      enum: ["admin", "client", "system"],
      default: "system",
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("PayoutNameLog", payoutNameLogSchema);
