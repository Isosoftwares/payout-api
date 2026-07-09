const mongoose = require('mongoose')


const supportSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
      },
      role: { type: String, required: true },
      userName: { type: String, required: true },
      customerUnread: { type: Number, default: 0 },
      adminUnread: { type: Number, default: 0 },
      messages: [{
          from: {type: String, required: true},
          message: {type: String, required: true},
          createdAt: {type: Date, required: false}
       },],


},{timestamps: true} )

const Support = mongoose.model('Support', supportSchema)

module.exports = Support