const mongoose = require("mongoose");

const maturitySettingSchema = new mongoose.Schema({
  dayOfWeek: {
    type: Number,
    required: true,
    unique: true,
    min: 0, // 0 = Sunday, 1 = Monday, etc.
    max: 6
  },
  offsetDays: {
    type: Number,
    required: true,
    default: 0
  },
  dayName: {
    type: String,
    required: true,
    enum: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  }
},{
  timestamps: true,
});

module.exports = mongoose.model("MaturitySetting", maturitySettingSchema);
