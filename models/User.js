// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ["admin", "client"],
    default: "client",
  },
  balance: {
    type: Number,
    default: 0,
    min: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  feePercentage: {
    type: Number,
    default: 0,
    min: 0,
  },
  mustChangePassword: {
    type: Boolean,
    default: false,
  },
  profile: {
    firstName: String,
    lastName: String,
    phone: String,
    company: String,
  },
  paymentMethods: [{
    type: {
      type: String,
      enum: ["mpesa", "bank", "crypto"],
      required: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Method to check if user has sufficient balance
userSchema.methods.hasSufficientBalance = function (amount) {
  return this.balance >= parseFloat(amount);
};

// Method to deduct balance
userSchema.methods.deductBalance = function (amount) {
  if (this.hasSufficientBalance(amount)) {
    this.balance -= parseFloat(amount);
    return this.save();
  } else {
    throw new Error("Insufficient balance");
  }
};

module.exports = mongoose.model("User", userSchema);
