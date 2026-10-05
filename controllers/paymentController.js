const PayoutName = require('../models/PayoutName');
const PayoutNameLog = require('../models/PayoutNameLog');
const MaturitySetting = require('../models/MaturitySetting');
const PaymentUploadHistory = require('../models/PaymentUploadHistory');
const PaymentRecord = require('../models/PaymentRecord');
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
    const paymentRecordsToCreate = [];
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
          paymentRecordsToCreate.push({
            payoutName: payoutName._id,
            name: payoutName.name,
            nameLower: payoutName.nameLower || payoutName.name.toLowerCase(),
            routingNumber: payoutName.routingNumber || '',
            accountNumber: payoutName.accountNumber || '',
            allocatedTo: payoutName.allocatedTo?._id || payoutName.allocatedTo || null,
            claimedForSubaccount: payoutName.claimedForSubaccount?._id || payoutName.claimedForSubaccount || null,
            amount: amount,
            paymentReceivedDate: paymentDate,
            maturityDate: maturityDate,
            paymentStatus: 'received',
            uploadRowNumber: processed,
            uploadFileName: req.file?.originalname || '',
            isReversed: false,
          });

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

    if (paymentRecordsToCreate.length > 0) {
      paymentRecordsToCreate.forEach((pr) => {
        pr.uploadHistoryId = history._id;
      });
      try {
        await PaymentRecord.insertMany(paymentRecordsToCreate);
      } catch (prErr) {
        console.error('Error inserting PaymentRecords:', prErr);
      }
    }

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
      .populate('reversedBy', 'profile email')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: histories });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const getReversalPreview = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await PaymentUploadHistory.findById(id)
      .populate('uploadedBy', 'profile email')
      .populate('reversedBy', 'profile email');

    if (!history) {
      return res.status(404).json({ message: "Upload history not found" });
    }

    const diffMs = Date.now() - new Date(history.createdAt).getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const isExpired = diffHours > 48;
    const hoursRemaining = Math.max(0, 48 - diffHours);

    const successItems = (history.items || []).filter(item => item.status === 'Success');
    const previewItems = [];
    let totalReversalAmount = 0;
    let paidCount = 0;
    let alreadyZeroCount = 0;
    const warnings = [];

    for (const item of successItems) {
      const itemAmount = parseFloat(String(item.amount).replace(/,/g, '').trim()) || 0;
      totalReversalAmount += itemAmount;

      const payoutName = await PayoutName.findOne({ nameLower: item.name.toLowerCase() })
        .populate('allocatedTo', 'profile email');

      let currentAmount = 0;
      let currentStatus = 'not_found';
      let newAmount = 0;
      let newStatus = 'not_received';
      let warning = null;
      let clientLabel = item.claimedBy || 'N/A';

      if (payoutName) {
        currentAmount = payoutName.amount || 0;
        currentStatus = payoutName.paymentStatus || 'not_received';
        newAmount = Math.max(0, currentAmount - itemAmount);

        if (currentStatus === 'paid') {
          paidCount++;
          warning = 'Already marked as PAID';
        } else if (currentAmount === 0) {
          alreadyZeroCount++;
          warning = 'Current amount is already $0.00';
        } else if (currentAmount < itemAmount) {
          warning = `Current amount ($${currentAmount.toFixed(2)}) is less than upload amount ($${itemAmount.toFixed(2)})`;
        }

        if (newAmount === 0) {
          newStatus = 'not_received';
        } else {
          newStatus = currentStatus;
        }

        if (payoutName.allocatedTo) {
          const client = payoutName.allocatedTo;
          clientLabel = client.profile?.company || client.profile?.companyName || [client.profile?.firstName, client.profile?.lastName].filter(Boolean).join(' ') || client.email;
        }
      } else {
        warning = 'Payout name not found in database';
      }

      previewItems.push({
        rowNum: item.rowNum,
        name: item.name,
        uploadAmount: itemAmount,
        uploadDate: item.date,
        currentAmount,
        newAmount,
        currentStatus,
        newStatus,
        clientLabel,
        warning
      });
    }

    if (history.isReversed) {
      warnings.push(`This upload was already reversed on ${new Date(history.reversedAt).toLocaleString()} by ${history.reversedBy?.email || 'admin'}.`);
    } else if (isExpired) {
      warnings.push(`The 48-hour reversal window has expired (Uploaded ${Math.floor(diffHours)} hours ago).`);
    }

    if (paidCount > 0) {
      warnings.push(`${paidCount} payout name(s) have already been marked as PAID.`);
    }

    res.status(200).json({
      success: true,
      data: {
        historyId: history._id,
        fileName: history.fileName,
        createdAt: history.createdAt,
        uploadedBy: history.uploadedBy,
        diffHours,
        hoursRemaining: hoursRemaining.toFixed(1),
        isExpired,
        isReversed: history.isReversed || false,
        reversedAt: history.reversedAt,
        reversedBy: history.reversedBy,
        reversalReason: history.reversalReason,
        totalProcessed: history.totalProcessed,
        totalMatched: history.totalMatched,
        totalReversalAmount,
        itemsCount: previewItems.length,
        items: previewItems,
        warnings,
        canReverse: !history.isReversed && !isExpired
      }
    });

  } catch (error) {
    console.error("Reversal preview error:", error);
    res.status(500).json({ message: "Server error generating reversal preview", error: error.message });
  }
};

const reversePaymentUpload = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim() || reason.trim().length < 3) {
      return res.status(400).json({ message: "Please provide a valid reason for the reversal (minimum 3 characters)." });
    }

    const history = await PaymentUploadHistory.findById(id);
    if (!history) {
      return res.status(404).json({ message: "Upload history not found" });
    }

    if (history.isReversed) {
      return res.status(400).json({
        message: `This upload has already been reversed on ${new Date(history.reversedAt).toLocaleString()}. Reversals can only be performed once.`
      });
    }

    const diffMs = Date.now() - new Date(history.createdAt).getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours > 48) {
      return res.status(400).json({
        message: "Cannot reverse upload: Reversal window expired (Uploads can only be reversed within 48 hours)."
      });
    }

    const successItems = (history.items || []).filter(item => item.status === 'Success');
    if (successItems.length === 0) {
      return res.status(400).json({ message: "No successful payments in this upload to reverse." });
    }

    let reversedCount = 0;
    let totalReversedAmount = 0;
    const reversalTime = new Date();

    // Mark all matching transaction ledger records as reversed
    try {
      await PaymentRecord.updateMany(
        { uploadHistoryId: history._id },
        { $set: { isReversed: true, reversedAt: reversalTime } }
      );
    } catch (prRevErr) {
      console.error('Error updating PaymentRecords on reversal:', prRevErr);
    }

    for (const item of successItems) {
      const itemAmount = parseFloat(String(item.amount).replace(/,/g, '').trim()) || 0;
      if (itemAmount <= 0) continue;

      const payoutName = await PayoutName.findOne({ nameLower: item.name.toLowerCase() });
      if (!payoutName) continue;

      const previousAmount = payoutName.amount || 0;
      const newAmount = Math.max(0, previousAmount - itemAmount);

      payoutName.amount = newAmount;

      if (newAmount === 0) {
        payoutName.paymentStatus = 'not_received';
        payoutName.paymentReceivedDate = null;
        payoutName.maturityDate = null;
      } else {
        // If remaining amount > 0, find prior payment_received log before this upload
        const priorPaymentLog = await PayoutNameLog.findOne({
          payoutName: payoutName._id,
          action: 'payment_received',
          timestamp: { $lt: history.createdAt }
        }).sort({ timestamp: -1 });

        if (priorPaymentLog && priorPaymentLog.paymentDate) {
          payoutName.paymentReceivedDate = priorPaymentLog.paymentDate;
          payoutName.maturityDate = priorPaymentLog.maturityDate;
          payoutName.paymentStatus = priorPaymentLog.maturityDate && new Date(priorPaymentLog.maturityDate) <= new Date() ? 'matured' : 'received';
        }
      }

      await payoutName.save();

      // Log reversal event on PayoutName
      await PayoutNameLog.create({
        payoutName: payoutName._id,
        action: 'payment_reversed',
        amount: itemAmount,
        paymentStatus: payoutName.paymentStatus,
        paymentDate: payoutName.paymentReceivedDate,
        maturityDate: payoutName.maturityDate,
        narration: `Payment upload reversed (${history.fileName}): ${reason.trim()}`,
        performedBy: req.user._id || null,
        performedByRole: req.user.role || 'admin',
        timestamp: reversalTime
      });

      // Update client user balance & send notifications
      const clientUserId = payoutName.allocatedTo;
      if (clientUserId) {
        await User.findByIdAndUpdate(clientUserId, {
          $inc: { totalReceivedUSD: -itemAmount }
        });

        await Notification.create({
          recipient: clientUserId,
          type: 'reversal',
          title: 'Payment Upload Reversed',
          message: `A payment of $${itemAmount.toFixed(2)} for ${payoutName.name} (${history.fileName}) was reversed. Reason: ${reason.trim()}`,
          link: '/client/payout-names'
        }).catch(() => {});

        const teleMsg = telegramService.formatNotification({
          icon: "⚠️",
          title: "Payment Reversed",
          message: `A payment of <b>$${itemAmount.toFixed(2)}</b> for payout name <b>${payoutName.name}</b> from file <i>${history.fileName}</i> was reversed by admin.\n<b>Reason:</b> ${reason.trim()}`,
          details: [
            { label: "Payout Name", value: payoutName.name },
            { label: "Deducted Amount", value: `-$${itemAmount.toFixed(2)}` },
            { label: "Remaining Amount", value: `$${newAmount.toFixed(2)}` },
            { label: "Current Status", value: payoutName.paymentStatus }
          ]
        });
        telegramService.sendToUser(clientUserId, teleMsg).catch(() => {});
      }

      reversedCount++;
      totalReversedAmount += itemAmount;
    }

    // Mark upload history as permanently reversed
    history.isReversed = true;
    history.reversedAt = reversalTime;
    history.reversedBy = req.user._id;
    history.reversalReason = reason.trim();
    history.reversalSummary = {
      reversedCount,
      totalReversedAmount
    };
    await history.save();

    res.status(200).json({
      success: true,
      message: `Reversal completed successfully. ${reversedCount} payment(s) reversed totaling $${totalReversedAmount.toFixed(2)}.`,
      data: {
        reversedCount,
        totalReversedAmount,
        history
      }
    });

  } catch (error) {
    console.error("Payment upload reversal error:", error);
    res.status(500).json({ message: "Server error during reversal", error: error.message });
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

// @desc    Add single payment to a payout name manually (no CSV required)
// @route   POST /api/payments/single
// @access  Private (Admin only)
const addSinglePayment = async (req, res) => {
  try {
    const { payoutNameId, name, amount, paymentDate: dateRaw, maturityDate: maturityRaw, clientId, narration } = req.body;

    if (!payoutNameId && !name) {
      return res.status(400).json({ message: "Payout name ID or name is required." });
    }

    const numAmount = parseFloat(String(amount || '').replace(/,/g, '').trim());
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ message: "Please provide a valid payment amount greater than 0." });
    }

    // Find payout name
    let query = {};
    if (payoutNameId) {
      query._id = payoutNameId;
    } else {
      query.nameLower = name.trim().toLowerCase();
    }

    const payoutName = await PayoutName.findOne(query)
      .populate('allocatedTo', 'email profile')
      .populate('claimedForSubaccount', 'username');

    if (!payoutName) {
      return res.status(404).json({ message: "Payout name not found." });
    }

    // Determine target client
    let targetClient = payoutName.allocatedTo;

    // Handle allocation / claiming if needed
    if (payoutName.status === 'available') {
      if (!clientId) {
        return res.status(400).json({ 
          message: "This payout name is currently available (unallocated). Please select a client to assign this payment to." 
        });
      }
      const clientDoc = await User.findById(clientId);
      if (!clientDoc || clientDoc.role !== 'client') {
        return res.status(400).json({ message: "Selected client was not found." });
      }
      payoutName.allocatedTo = clientDoc._id;
      payoutName.status = 'claimed';
      payoutName.claimedAt = new Date();
      targetClient = clientDoc;
    } else if (payoutName.status === 'allocated') {
      payoutName.status = 'claimed';
      payoutName.claimedAt = payoutName.claimedAt || new Date();
    }

    // Parse payment date
    let paymentDate = dateRaw ? parseCalendarDate(dateRaw) : new Date();
    if (!paymentDate || isNaN(paymentDate.getTime())) {
      paymentDate = new Date();
    }
    paymentDate = new Date(Date.UTC(paymentDate.getUTCFullYear(), paymentDate.getUTCMonth(), paymentDate.getUTCDate(), 0, 0, 0, 0));

    // Calculate or parse maturity date
    let finalMaturityDate = null;
    if (maturityRaw) {
      finalMaturityDate = parseCalendarDate(maturityRaw);
    }

    if (!finalMaturityDate || isNaN(finalMaturityDate.getTime())) {
      const settings = await MaturitySetting.find();
      const settingsMap = {};
      settings.forEach(s => settingsMap[s.dayOfWeek] = s.offsetDays);
      const dayOfWeek = paymentDate.getUTCDay();
      const offsetDays = settingsMap[dayOfWeek] !== undefined ? settingsMap[dayOfWeek] : 2;
      finalMaturityDate = new Date(paymentDate);
      finalMaturityDate.setUTCDate(finalMaturityDate.getUTCDate() + offsetDays);
    } else {
      finalMaturityDate = new Date(Date.UTC(finalMaturityDate.getUTCFullYear(), finalMaturityDate.getUTCMonth(), finalMaturityDate.getUTCDate(), 0, 0, 0, 0));
    }

    // Apply amount to payout name
    if (payoutName.paymentStatus === 'received' || payoutName.paymentStatus === 'matured') {
      payoutName.amount = (payoutName.amount || 0) + numAmount;
      payoutName.paymentReceivedDate = paymentDate;
      if (!payoutName.maturityDate || finalMaturityDate > payoutName.maturityDate) {
        payoutName.maturityDate = finalMaturityDate;
      }
      payoutName.paymentStatus = 'received';
    } else {
      payoutName.amount = numAmount;
      payoutName.paymentReceivedDate = paymentDate;
      payoutName.maturityDate = finalMaturityDate;
      payoutName.paymentStatus = 'received';
    }

    await payoutName.save();

    // Create Activity Log
    const newLog = await PayoutNameLog.create({
      payoutName: payoutName._id,
      action: 'payment_received',
      amount: numAmount,
      paymentStatus: 'received',
      paymentDate: paymentDate,
      maturityDate: finalMaturityDate,
      narration: narration && narration.trim() 
        ? narration.trim() 
        : `Manual single payment received: $${numAmount.toFixed(2)}`,
      performedBy: req.user?._id || req.user?.id || null,
      performedByRole: 'admin',
      timestamp: new Date()
    });

    // Create PaymentRecord for ledger
    await PaymentRecord.create({
      payoutName: payoutName._id,
      name: payoutName.name,
      nameLower: payoutName.nameLower || payoutName.name.toLowerCase(),
      routingNumber: payoutName.routingNumber || '',
      accountNumber: payoutName.accountNumber || '',
      allocatedTo: payoutName.allocatedTo?._id || payoutName.allocatedTo || null,
      claimedForSubaccount: payoutName.claimedForSubaccount?._id || payoutName.claimedForSubaccount || null,
      amount: numAmount,
      paymentReceivedDate: paymentDate,
      maturityDate: finalMaturityDate,
      paymentStatus: 'received',
      uploadRowNumber: 1,
      uploadFileName: 'Single Payment Entry',
      isReversed: false,
    });

    // Resolve client label for upload history
    let clientLabel = 'N/A';
    if (targetClient) {
      const email = targetClient.email || '';
      const nameStr = targetClient.profile?.companyName || 
        [targetClient.profile?.firstName, targetClient.profile?.lastName].filter(Boolean).join(' ') || 
        email;
      clientLabel = `${nameStr} (${email})`;
    }

    // Create PaymentUploadHistory so it appears in audit & reversal system
    await PaymentUploadHistory.create({
      uploadedBy: req.user?._id || req.user?.id,
      fileName: `Manual Entry: ${payoutName.name} ($${numAmount.toFixed(2)})`,
      totalProcessed: 1,
      totalMatched: 1,
      items: [{
        rowNum: 1,
        name: payoutName.name,
        amount: numAmount.toFixed(2),
        date: paymentDate.toISOString().split('T')[0],
        status: 'Success',
        claimedBy: clientLabel,
        reason: narration ? `Manual payment: ${narration.trim()}` : 'Manual payment added via Payout Names'
      }],
      errors: []
    });

    // Update Client User metrics and dispatch notifications
    const clientUserId = payoutName.allocatedTo?._id || payoutName.allocatedTo;
    if (clientUserId) {
      await User.findByIdAndUpdate(clientUserId, {
        $inc: { totalReceivedUSD: numAmount }
      });

      await Notification.create({
        recipient: clientUserId,
        type: 'deposit',
        title: 'Payment Received',
        message: `A payment of $${numAmount.toFixed(2)} was received for payout name ${payoutName.name}.`,
        link: '/client/payout-names'
      });

      const teleMsg = telegramService.formatNotification({
        icon: "💰",
        title: "Payment Received",
        message: `A payment of <b>$${numAmount.toFixed(2)}</b> was received for payout name <b>${payoutName.name}</b>.`,
        details: [
          { label: "Payout Name", value: payoutName.name },
          { label: "Amount", value: `$${numAmount.toFixed(2)}` },
          { label: "Payment Status", value: payoutName.paymentStatus },
          { label: "Maturity Date", value: new Date(finalMaturityDate).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) }
        ]
      });
      telegramService.sendToUser(clientUserId, teleMsg).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: `Payment of $${numAmount.toFixed(2)} added to ${payoutName.name} successfully.`,
      data: {
        payoutName,
        log: newLog
      }
    });

  } catch (error) {
    console.error("Add single payment error:", error);
    return res.status(500).json({ message: "Server error adding payment", error: error.message });
  }
};

module.exports = {
  uploadPayments,
  addSinglePayment,
  getMaturitySettings,
  updateMaturitySettings,
  getUploadHistories,
  downloadUploadReport,
  getReversalPreview,
  reversePaymentUpload
};
