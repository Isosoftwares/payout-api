const mongoose = require("mongoose");

const paymentRecordSchema = new mongoose.Schema(
  {
    payoutName: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutName",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    nameLower: {
      type: String,
      required: true,
      index: true,
    },
    routingNumber: {
      type: String,
      default: "",
    },
    accountNumber: {
      type: String,
      default: "",
    },
    allocatedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    claimedForSubaccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subaccount",
      default: null,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    paymentReceivedDate: {
      type: Date,
      required: true,
      index: true,
    },
    maturityDate: {
      type: Date,
      default: null,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: ["received", "matured", "paid"],
      default: "received",
      index: true,
    },
    uploadHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentUploadHistory",
      default: null,
      index: true,
    },
    uploadFileName: {
      type: String,
      default: "",
    },
    uploadRowNumber: {
      type: Number,
      default: 0,
    },
    isReversed: {
      type: Boolean,
      default: false,
      index: true,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    payoutTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutTransaction",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

paymentRecordSchema.index({ paymentReceivedDate: 1, isReversed: 1 });
paymentRecordSchema.index({ maturityDate: 1, isReversed: 1 });
paymentRecordSchema.index({ allocatedTo: 1, isReversed: 1 });

module.exports = mongoose.model("PaymentRecord", paymentRecordSchema);
