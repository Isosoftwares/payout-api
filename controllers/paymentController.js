const PayoutName = require('../models/PayoutName');
const PayoutNameLog = require('../models/PayoutNameLog');
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

    const items = [];
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
        const reason = "Missing required fields";
        errors.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw || '', reason });
        items.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw || '', status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

      const amount = parseFloat(amountRaw.toString().replace(/,/g, '').trim());
      if (isNaN(amount) || amount <= 0) {
        const reason = "Invalid amount format";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason });
        items.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, status: 'Failed', claimedBy: 'N/A', reason });
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
        const reason = "Invalid date format";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason });
        items.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

      // Calculate maturity
      const dayOfWeek = paymentDate.getUTCDay();
      const offsetDays = settingsMap[dayOfWeek] || 2;
      const maturityDate = new Date(paymentDate);
      maturityDate.setUTCDate(maturityDate.getUTCDate() + offsetDays);

      const payoutName = await PayoutName.findOne({ nameLower: name.toLowerCase() })
        .populate('allocatedTo', 'email profile')
        .populate('claimedForSubaccount', 'username');

      if (payoutName) {
        // Resolve who the name is claimed or allocated to
        let claimedByLabel = 'Available Pool (Unallocated)';
        if (payoutName.allocatedTo) {
          const clientEmail = payoutName.allocatedTo.email || '';
          const clientName = payoutName.allocatedTo.profile?.companyName ||
            [payoutName.allocatedTo.profile?.firstName, payoutName.allocatedTo.profile?.lastName].filter(Boolean).join(' ') ||
            clientEmail;
          const subLabel = payoutName.claimedForSubaccount?.username
            ? `Subaccount: ${payoutName.claimedForSubaccount.username}`
            : 'Self';

          if (payoutName.status === 'claimed') {
            claimedByLabel = `${clientName} (${clientEmail}) [${subLabel}]`;
          } else if (payoutName.status === 'allocated') {
            claimedByLabel = `Allocated to: ${clientName} (${clientEmail}) [Unclaimed]`;
          } else {
            claimedByLabel = `Available (Assigned: ${clientEmail})`;
          }
        } else if (payoutName.status === 'claimed') {
          claimedByLabel = 'Claimed (No Client Linked)';
        }

        if (payoutName.status !== 'claimed') {
          const reason = `Payout name is not claimed (Current status: ${payoutName.status})`;
          errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason });
          items.push({
            rowNum: processed,
            name,
            amount: amountRaw,
            date: dateRaw,
            status: 'Failed',
            claimedBy: claimedByLabel,
            reason
          });
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

          try {
            await PayoutNameLog.create({
              payoutName: payoutName._id,
              action: 'payment_received',
              amount: amount,
              paymentStatus: 'received',
              paymentDate: paymentDate,
              maturityDate: maturityDate,
              narration: req.file?.originalname ? `Payment received via upload: ${req.file.originalname}` : 'Payment received',
              performedBy: req.user?._id || null,
              performedByRole: req.user?.role || 'admin',
              timestamp: new Date()
            });
          } catch (logErr) {
            console.error('Error logging payment received:', logErr);
          }

          const clientUserId = payoutName.allocatedTo?._id || payoutName.allocatedTo;
          if (clientUserId) {
            await User.findByIdAndUpdate(clientUserId, {
              $inc: { totalReceivedUSD: amount }
            });

            await Notification.create({
              recipient: clientUserId,
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
                ...(payoutName.maturityDate ? [{ label: "Maturity Date", value: new Date(payoutName.maturityDate).toLocaleDateString() }] : [])
              ]
            });
            telegramService.sendToUser(clientUserId, teleMsg).catch(() => {});
          }

          matched++;
          items.push({
            rowNum: processed,
            name,
            amount: amountRaw,
            date: dateRaw,
            status: 'Success',
            claimedBy: claimedByLabel,
            reason: 'Payment applied successfully'
          });
        }
      } else {
        const reason = "Payout name not found in database";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateRaw, reason });
        items.push({
          rowNum: processed,
          name,
          amount: amountRaw,
          date: dateRaw,
          status: 'Failed',
          claimedBy: 'Not Found in DB',
          reason
        });
      }
    }

    // Cleanup file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Save history with items and errors
    const history = await PaymentUploadHistory.create({
      uploadedBy: req.user.id,
      fileName: req.file.originalname,
      totalProcessed: processed,
      totalMatched: matched,
      items: items,
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

    let records = [];
    if (history.items && history.items.length > 0) {
      records = history.items.map(item => ({
        rowNum: item.rowNum,
        name: item.name,
        amount: item.amount,
        date: item.date,
        status: item.status || 'Success',
        claimedBy: item.claimedBy || 'N/A',
        reason: item.reason || ''
      }));
    } else if (history.errors && history.errors.length > 0) {
      // Fallback for older upload records
      records = history.errors.map(err => ({
        rowNum: err.rowNum,
        name: err.name,
        amount: err.amount,
        date: err.date,
        status: 'Failed',
        claimedBy: 'N/A',
        reason: err.reason || ''
      }));
    }

    if (records.length === 0) {
      return res.status(400).json({ message: "No records found for this upload to download" });
    }

    const csvStringifier = createObjectCsvStringifier({
      header: [
        { id: 'rowNum', title: 'Row Number' },
        { id: 'name', title: 'Payout Name' },
        { id: 'amount', title: 'Amount' },
        { id: 'date', title: 'Date' },
        { id: 'status', title: 'Status' },
        { id: 'claimedBy', title: 'Claimed / Allocated To' },
        { id: 'reason', title: 'Reason / Notes' }
      ]
    });

    const header = csvStringifier.getHeaderString();
    const recordsCsv = csvStringifier.stringifyRecords(records);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="upload_report_${history._id}.csv"`);
    res.send(header + recordsCsv);

  } catch (error) {
    console.error("Download upload report error:", error);
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
