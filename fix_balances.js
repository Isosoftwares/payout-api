require('dotenv').config();
const mongoose = require('mongoose');
const VirtualAccount = require('./models/VirtualAccount');
const Transaction = require('./models/Transaction');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const accounts = await VirtualAccount.find();
  let fixedCount = 0;
  for (const acc of accounts) {
    if (acc.balance > 100000 || isNaN(acc.balance)) {
      console.log(`Corrupted Account ID: ${acc._id}, Balance: ${acc.balance}, Withdrawable: ${acc.withdrawableBalance}`);
      
      const txs = await Transaction.find({ virtualAccount: acc._id }).sort({ createdAt: -1 }).limit(5);
      console.log('Recent transactions:');
      txs.forEach(t => console.log(t.type, t.grossAmount, t.netAmount));

      if (acc.withdrawableBalance <= 0) {
         acc.balance = 0;
         acc.withdrawableBalance = 0;
      } else {
         acc.balance = acc.withdrawableBalance;
      }
      await acc.save();
      console.log('Fixed account:', acc._id);
      fixedCount++;
    }
  }
  console.log(`Fixed ${fixedCount} corrupted accounts.`);
  process.exit();
}).catch(console.error);
