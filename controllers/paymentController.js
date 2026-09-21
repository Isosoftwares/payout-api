const PayoutName = require('../models/PayoutName');
const MaturitySetting = require('../models/MaturitySetting');
const PaymentUploadHistory = require('../models/PaymentUploadHistory');
const XLSX = require('xlsx');
const fs = require('fs');
const { createObjectCsvStringifier } = require('csv-writer');
const Notification = require('../models/Notification');
const User = require('../models/User');
const telegramService = require('../services/telegramService');

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
      return res.status(400).json({ message: "Please upload a CSV or Excel file" });
    }

    await initializeMaturitySettings();
    const maturitySettings = await MaturitySetting.find({});
    const settingsMap = {};
    maturitySettings.forEach(s => {
      settingsMap[s.dayOfWeek] = s.offsetDays;
    });

    let results = [];
    try {
      const workbook = XLSX.readFile(req.file.path, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      results = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
    } catch (parseErr) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ message: "Failed to parse file. Please ensure it is a valid CSV or Excel file.", error: parseErr.message });
    }

    if (results.length === 0) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ message: "The uploaded file is empty." });
    }

    // Check headers on first row
    const firstRowKeys = Object.keys(results[0]).map(k => k.trim().toLowerCase());
    const hasNameHeader = firstRowKeys.some(k => k === 'name');
    const hasAmountHeader = firstRowKeys.some(k => k === 'amount');
    const hasDateHeader = firstRowKeys.some(k => k === 'date');

    if (!hasNameHeader || !hasAmountHeader || !hasDateHeader) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ message: "Invalid headers. File must contain columns: Name, Amount, Date" });
    }

    const errors = [];
    let processed = 0;
    let matched = 0;

    for (const row of results) {
      processed++;
      let name = null;
      let amountRaw = null;
      let dateRaw = null;

      for (const key of Object.keys(row)) {
        const lower = key.trim().toLowerCase();
        if (lower === 'name') name = String(row[key]).trim();
        else if (lower === 'amount') amountRaw = row[key];
        else if (lower === 'date') dateRaw = row[key];
      }

      if (!name || amountRaw === undefined || amountRaw === null || amountRaw === '' || dateRaw === undefined || dateRaw === null || dateRaw === '') {
        errors.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw || '', reason: "Missing required fields" });
        continue;
      }

      const amount = parseFloat(amountRaw.toString().replace(/,/g, '').trim());
      if (isNaN(amount) || amount <= 0) {
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Invalid amount format" });
        continue;
      }

      // Parse date: support JS Date, Excel serial number, DD/MM/YYYY, or ISO string
      let paymentDate;
      if (dateRaw instanceof Date) {
        paymentDate = dateRaw;
      } else if (typeof dateRaw === 'number') {
        paymentDate = new Date((dateRaw - (25567 + 2)) * 86400 * 1000);
      } else if (typeof dateRaw === 'string' && dateRaw.includes('/')) {
        const parts = dateRaw.trim().split('/');
        if (parts.length === 3) {
          paymentDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00Z`);
        }
      } else {
        paymentDate = new Date(dateRaw);
      }

      if (!paymentDate || isNaN(paymentDate.getTime())) {
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Invalid date format" });
        continue;
      }

      // Calculate maturity
      const dayOfWeek = paymentDate.getUTCDay();
      const offsetDays = settingsMap[dayOfWeek] || 2;
      const maturityDate = new Date(paymentDate);
      maturityDate.setUTCDate(maturityDate.getUTCDate() + offsetDays);

      const payoutName = await PayoutName.findOne({ nameLower: name.toLowerCase() });

      if (payoutName) {
        if (payoutName.status !== 'claimed') {
          errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: `Payout name is not claimed (Current status: ${payoutName.status})` });
        } else {
          if (payoutName.paymentStatus === 'received' || payoutName.paymentStatus === 'matured') {
            payoutName.amount = (payoutName.amount || 0) + amount;
            if (!payoutName.maturityDate || maturityDate > payoutName.maturityDate) {
              payoutName.maturityDate = maturityDate;
              payoutName.paymentReceivedDate = paymentDate;
            }
            payoutName.paymentStatus = 'received';
          } else {
            payoutName.amount = amount;
            payoutName.paymentReceivedDate = paymentDate;
            payoutName.maturityDate = maturityDate;
            payoutName.paymentStatus = 'received';
          }
          await payoutName.save();

          if (payoutName.allocatedTo) {
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

            // Send Telegram Notification to client
            const teleMsg = telegramService.formatNotification({
              icon: "💰",
              title: "Payment Received",
              message: `A payment of <b>$${amount.toFixed(2)}</b> was received for payout name <b>${payoutName.name}</b>.`,
              details: [
                { label: "Payout Name", value: payoutName.name },
                { label: "Amount", value: `$${amount.toFixed(2)}` },
                { label: "Payment Status", value: payoutName.paymentStatus },
                ...(payoutName.maturedAt ? [{ label: "Maturity Date", value: new Date(payoutName.maturedAt).toLocaleDateString() }] : [])
              ]
            });
            telegramService.sendToUser(payoutName.allocatedTo, teleMsg).catch(() => {});
          }

          matched++;
        }
      } else {
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason: "Payout name not found in database" });
      }
    }

    // Cleanup file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

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
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
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
