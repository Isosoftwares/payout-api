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

// Accurately parses date representations (Excel serial, Date object, YYYY-MM-DD, DD/MM/YYYY, etc.)
// into a pure UTC midnight Date object (00:00:00.000Z) with zero timezone offset drift.
const parseCalendarDate = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;

  // Reject literal null/empty strings
  const str = String(raw).trim();
  if (!str || ['null', 'undefined', 'n/a', 'na', 'none', 'nil', '-', '0', 'invalid date'].includes(str.toLowerCase())) {
    return null;
  }

  // 1. If raw is already a Date object
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate(), 0, 0, 0, 0));
  }

  // 2. If raw is an Excel serial number (number or numeric string like 46289)
  if (typeof raw === 'number' && !isNaN(raw)) {
    const p = XLSX.SSF.parse_date_code(Math.floor(raw));
    if (p && p.y && p.m && p.d) {
      return new Date(Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0));
    }
  }

  // Pure 5-digit Excel serial as string e.g. '46289'
  if (/^\d{5}$/.test(str)) {
    const p = XLSX.SSF.parse_date_code(parseInt(str, 10));
    if (p && p.y && p.m && p.d) {
      return new Date(Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0));
    }
  }

  // 3. YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) {
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    }
  }

  // 4. DD/MM/YYYY or MM/DD/YYYY or DD-MM-YYYY
  const slashMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (slashMatch) {
    let p1 = parseInt(slashMatch[1], 10);
    let p2 = parseInt(slashMatch[2], 10);
    let y = parseInt(slashMatch[3], 10);
    if (y < 100) y += 2000;
    let d, m;
    if (p1 > 12) {
      d = p1;
      m = p2;
    } else if (p2 > 12) {
      m = p1;
      d = p2;
    } else {
      // Default: DD/MM/YYYY
      d = p1;
      m = p2;
    }
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) {
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    }
  }

  // 5. Fallback ISO or standard Date string
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) {
    if (str.includes('Z')) {
      return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0, 0, 0, 0));
    }
    return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0));
  }

  return null;
};

// Flexible column name matching
const isNameKey = (k) => ['name', 'payout name', 'payoutname', 'payout_name'].includes(k);
const isAmountKey = (k) => ['amount', 'payment amount', 'amount (usd)', 'usd', 'amount_usd'].includes(k);
const isDateKey = (k) => [
  'date',
  'payment date',
  'paymentdate',
  'payment_date',
  'received date',
  'receiveddate',
  'received_date',
  'date received',
  'payment received date',
  'date_received'
].includes(k);

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
      const workbook = XLSX.readFile(req.file.path, { cellDates: false });
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

    // Check headers on first row with flexible matching
    const firstRowKeys = Object.keys(results[0]).map(k => k.trim().toLowerCase());
    const hasNameHeader = firstRowKeys.some(isNameKey);
    const hasAmountHeader = firstRowKeys.some(isAmountKey);
    const hasDateHeader = firstRowKeys.some(isDateKey);

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
        if (isNameKey(lower)) name = String(row[key]).trim();
        else if (isAmountKey(lower)) amountRaw = row[key];
        else if (isDateKey(lower)) dateRaw = row[key];
      }

      if (!name || amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === '' || dateRaw === undefined || dateRaw === null || String(dateRaw).trim() === '') {
        const reason = "Missing required fields (Name, Amount, or Date is empty)";
        errors.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw ? String(dateRaw) : 'N/A', reason });
        items.push({ rowNum: processed, name: name || '', amount: amountRaw || '', date: dateRaw ? String(dateRaw) : 'N/A', status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

      const amount = parseFloat(amountRaw.toString().replace(/,/g, '').trim());
      if (isNaN(amount) || amount <= 0) {
        const reason = "Invalid amount format";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: String(dateRaw), reason });
        items.push({ rowNum: processed, name, amount: amountRaw, date: String(dateRaw), status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

      // Parse date: support JS Date, Excel serial number, DD/MM/YYYY, or ISO string
      const paymentDate = parseCalendarDate(dateRaw);

      if (!paymentDate || isNaN(paymentDate.getTime())) {
        const reason = "Invalid or empty date format";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: String(dateRaw || 'N/A'), reason });
        items.push({ rowNum: processed, name, amount: amountRaw, date: String(dateRaw || 'N/A'), status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

      const dateISOStr = paymentDate.toISOString().split('T')[0];

      // Calculate maturity at UTC midnight
      const dayOfWeek = paymentDate.getUTCDay();
      const offsetDays = settingsMap[dayOfWeek] !== undefined ? settingsMap[dayOfWeek] : 2;
      const maturityDate = new Date(paymentDate);
      maturityDate.setUTCDate(maturityDate.getUTCDate() + offsetDays);

      if (!maturityDate || isNaN(maturityDate.getTime())) {
        const reason = "Failed to calculate maturity date";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateISOStr, reason });
        items.push({ rowNum: processed, name, amount: amountRaw, date: dateISOStr, status: 'Failed', claimedBy: 'N/A', reason });
        continue;
      }

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
          errors.push({ rowNum: processed, name, amount: amountRaw, date: dateISOStr, reason });
          items.push({
            rowNum: processed,
            name,
            amount: amountRaw,
            date: dateISOStr,
            status: 'Failed',
            claimedBy: claimedByLabel,
            reason
          });
        } else {
          if (payoutName.paymentStatus === 'received' || payoutName.paymentStatus === 'matured') {
            payoutName.amount = (payoutName.amount || 0) + amount;
            // Always set paymentReceivedDate to paymentDate (never null)
            payoutName.paymentReceivedDate = paymentDate;
            if (!payoutName.maturityDate || maturityDate > payoutName.maturityDate) {
              payoutName.maturityDate = maturityDate;
            }
            payoutName.paymentStatus = 'received';
          } else {
            payoutName.amount = amount;
            payoutName.paymentReceivedDate = paymentDate;
            payoutName.maturityDate = maturityDate;
            payoutName.paymentStatus = 'received';
          }

          // Strict guarantee: neither date can ever be null or invalid
          if (!payoutName.paymentReceivedDate || isNaN(payoutName.paymentReceivedDate.getTime())) {
            payoutName.paymentReceivedDate = paymentDate;
          }
          if (!payoutName.maturityDate || isNaN(payoutName.maturityDate.getTime())) {
            payoutName.maturityDate = maturityDate;
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
                ...(payoutName.maturityDate ? [{ label: "Maturity Date", value: new Date(payoutName.maturityDate).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) }] : [])
              ]
            });
            telegramService.sendToUser(clientUserId, teleMsg).catch(() => {});
          }

          matched++;
          items.push({
            rowNum: processed,
            name,
            amount: amountRaw,
            date: dateISOStr,
            status: 'Success',
            claimedBy: claimedByLabel,
            reason: 'Payment applied successfully'
          });
        }
      } else {
        const reason = "Payout name not found in database";
        errors.push({ rowNum: processed, name, amount: amountRaw, date: dateISOStr, reason });
        items.push({
          rowNum: processed,
          name,
          amount: amountRaw,
          date: dateISOStr,
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

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="upload_report_${history._id}.csv"`);
    res.send('\uFEFF' + header + recordsCsv);

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
