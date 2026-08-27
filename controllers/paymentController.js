const PayoutName = require('../models/PayoutName');
const MaturitySetting = require('../models/MaturitySetting');
const PaymentUploadHistory = require('../models/PaymentUploadHistory');
const csv = require('csv-parser');
const fs = require('fs');
const { createObjectCsvStringifier } = require('csv-writer');
const Notification = require('../models/Notification');

// Seed maturity settings if they don't exist
const initializeMaturitySettings = async () => {
  const count = await MaturitySetting.countDocuments();
  if (count === 0) {
    const defaultSettings = [
      { dayOfWeek: 0, dayName: "Sunday", offsetDays: 1 },
      { dayOfWeek: 1, dayName: "Monday", offsetDays: 2 },
      { dayOfWeek: 2, dayName: "Tuesday", offsetDays: 2 },
      { dayOfWeek: 3, dayName: "Wednesday", offsetDays: 2 },
      { dayOfWeek: 4, dayName: "Thursday", offsetDays: 2 },
      { dayOfWeek: 5, dayName: "Friday", offsetDays: 4 }, // skips weekend
      { dayOfWeek: 6, dayName: "Saturday", offsetDays: 3 }, // skips weekend
    ];
    await MaturitySetting.insertMany(defaultSettings);
  }
};

const uploadPayments = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a CSV file" });
    }


    await initializeMaturitySettings();
    const maturitySettings = await MaturitySetting.find({});
    const settingsMap = {};
    maturitySettings.forEach(s => {
      settingsMap[s.dayOfWeek] = s.offsetDays;
    });

    const results = [];
    const errors = [];
    let processed = 0;
    let matched = 0;

    let hasInvalidHeaders = false;

    const stream = fs.createReadStream(req.file.path).pipe(csv());

    stream.on('headers', (headers) => {
      const lowerHeaders = headers.map(h => h.toLowerCase().trim());
      const hasName = lowerHeaders.includes('name');
      const hasAmount = lowerHeaders.includes('amount');
      const hasDate = lowerHeaders.includes('date');

      if (!hasName || !hasAmount || !hasDate) {
        hasInvalidHeaders = true;
        // Destroy the stream to stop processing
        stream.destroy(new Error('Invalid CSV Headers. Required headers: Name, Amount, Date'));
      }
    });

    stream.on('error', (error) => {
      fs.unlink(req.file.path, (err) => { if (err) console.error(err) });
      if (hasInvalidHeaders) {
        return res.status(400).json({ message: error.message });
      }
      return res.status(500).json({ message: "Error reading CSV file", error: error.message });
    });

    stream.on('data', (data) => {
      if (!hasInvalidHeaders) results.push(data);
    });

    stream.on('end', async () => {
      if (hasInvalidHeaders) return; // Response already sent in error handler
        try {
          for (const row of results) {
            processed++;
            // Assume CSV columns: Name, Amount, Date
            const name = row.Name || row.name;
            const amountRaw = row.Amount || row.amount;
            const dateRaw = row.Date || row.date;

            if (!name || !amountRaw || !dateRaw) {
              errors.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw || '', reason: "Missing required fields" });
              continue;
            }

            const amount = parseFloat(amountRaw.toString().replace(/,/g, ''));
            if (isNaN(amount)) {
              errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Invalid amount format" });
              continue;
            }

            // Parse DD/MM/YYYY or YYYY-MM-DD
            let paymentDate;
            if (dateRaw.includes('/')) {
              const parts = dateRaw.split('/');
              if (parts.length === 3) {
                // assume DD/MM/YYYY
                paymentDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00Z`);
              }
            } else {
              paymentDate = new Date(dateRaw);
            }

            if (isNaN(paymentDate.getTime())) {
              errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Invalid date format" });
              continue;
            }

            // Calculate maturity
            const dayOfWeek = paymentDate.getUTCDay();
            const offsetDays = settingsMap[dayOfWeek] || 2; // Default to 2 if missing
            const maturityDate = new Date(paymentDate);
            maturityDate.setUTCDate(maturityDate.getUTCDate() + offsetDays);

            const payoutName = await PayoutName.findOne({ nameLower: name.toString().toLowerCase() });
            
            if (payoutName) {
              if (payoutName.status !== 'claimed') {
                errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: `Payout name is not claimed (Current status: ${payoutName.status})` });
              } else {
                if (payoutName.paymentStatus === 'received' || payoutName.paymentStatus === 'matured') {
                  // Accumulate amount and use latest maturity date
                  payoutName.amount = (payoutName.amount || 0) + amount;
                  if (!payoutName.maturityDate || maturityDate > payoutName.maturityDate) {
                    payoutName.maturityDate = maturityDate;
                    payoutName.paymentReceivedDate = paymentDate;
                  }
                  payoutName.paymentStatus = 'received'; // Reverts to received until new amount matures
                } else {
                  // Either paid or not_received, start fresh
                  payoutName.amount = amount;
                  payoutName.paymentReceivedDate = paymentDate;
                  payoutName.maturityDate = maturityDate;
                  payoutName.paymentStatus = 'received';
                }
                await payoutName.save();
                
                // Create notification and increment totalReceivedUSD for the client
                if (payoutName.allocatedTo) {
                  const User = require('../models/User');
                  await User.findByIdAndUpdate(payoutName.allocatedTo, {
                    $inc: { totalReceivedUSD: amount }
                  });
                  
                  await Notification.create({
                    recipient: payoutName.allocatedTo,
                    type: 'deposit',
                    title: 'Payment Received',
                    message: `A payment of $${amount} was received for payout name ${payoutName.name}.`,
                    link: '/client/payout-names'
                  });
                }
                
                matched++;
              }
            } else {
              errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Payout name not found in database" });
            }
          }

          // Cleanup file
          fs.unlink(req.file.path, (err) => {
            if (err) console.error("Failed to delete temp file:", err);
          });

          // Save history
          const history = await PaymentUploadHistory.create({
            uploadedBy: req.user.id,
            fileName: req.file.originalname,
            totalProcessed: processed,
            totalMatched: matched,
            errors: errors
          });

          res.status(200).json({
            success: true,
            message: `Processed ${processed} records. Matched and updated ${matched}.`,
            errors: errors.length > 0 ? errors : undefined,
            matchedCount: matched,
            historyId: history._id
          });

        } catch (error) {
          console.error("Error processing CSV:", error);
          res.status(500).json({ message: "Error processing CSV data", error: error.message });
        }
      });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Server error during upload", error: error.message });
  }
};

const getMaturitySettings = async (req, res) => {
  try {
    await initializeMaturitySettings();
    const settings = await MaturitySetting.find({}).sort({ dayOfWeek: 1 });
    res.status(200).json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const updateMaturitySettings = async (req, res) => {
  try {
    const { settings } = req.body; // Array of { _id, offsetDays }
    if (!Array.isArray(settings)) {
      return res.status(400).json({ message: "Settings must be an array" });
    }

    for (const setting of settings) {
      if (setting._id && setting.offsetDays !== undefined) {
        await MaturitySetting.findByIdAndUpdate(setting._id, { offsetDays: setting.offsetDays });
      }
    }

    res.status(200).json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getUploadHistories = async (req, res) => {
  try {
    const histories = await PaymentUploadHistory.find({})
      .populate('uploadedBy', 'profile email')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: histories });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const downloadUploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await PaymentUploadHistory.findById(id);
    if (!history) {
      return res.status(404).json({ message: "History not found" });
    }

    if (!history.errors || history.errors.length === 0) {
      return res.status(400).json({ message: "No errors in this upload to download" });
    }

    const csvStringifier = createObjectCsvStringifier({
      header: [
        { id: 'rowNum', title: 'Row Number' },
        { id: 'name', title: 'Name' },
        { id: 'amount', title: 'Amount' },
        { id: 'date', title: 'Date' },
        { id: 'reason', title: 'Error Reason' }
      ]
    });

    const header = csvStringifier.getHeaderString();
    const records = csvStringifier.stringifyRecords(history.errors);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="upload_errors_${history._id}.csv"`);
    res.send(header + records);

  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

module.exports = {
  uploadPayments,
  getMaturitySettings,
  updateMaturitySettings,
  getUploadHistories,
  downloadUploadReport
};
