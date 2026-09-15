const mongoose = require("mongoose");

const specificNameRequestSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requestedName: {
      type: String,
      required: true,
      trim: true,
    },
    requestedNameLower: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    subaccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subaccount",
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
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
    adminNote: {
      type: String,
      default: "",
    },
    payoutName: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PayoutName",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("SpecificNameRequest", specificNameRequestSchema);
