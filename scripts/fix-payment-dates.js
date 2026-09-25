/**
 * Fix Payment Dates Migration Script
 * 
 * Corrects paymentReceivedDate and maturityDate to exact UTC Midnight (00:00:00.000Z)
 * for payments uploaded before the timezone shift fix.
 * 
 * Usage:
 *   node scripts/fix-payment-dates.js --help
 * 
 * Modes:
 *   1. From CSV/Excel files:
 *      node scripts/fix-payment-dates.js --files ./payments1.csv ./payments2.xlsx
 *      node scripts/fix-payment-dates.js --dir ./uploads/csv-documents
 * 
 *   2. From MongoDB Upload History:
 *      node scripts/fix-payment-dates.js --from-history
 * 
 *   3. Direct Database Timestamp Normalization:
 *      node scripts/fix-payment-dates.js --normalize-db
 * 
 * Flags:
 *   --dry-run       Preview changes without writing to database
 *   --tz-offset 3   Server timezone offset in hours (default: 3 for EAT)
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PayoutName = require('../models/PayoutName');
const PayoutNameLog = require('../models/PayoutNameLog');
const PaymentUploadHistory = require('../models/PaymentUploadHistory');
const MaturitySetting = require('../models/MaturitySetting');

// Flexible header detection
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

/**
 * Accurately parses date representations (Excel serial, Date object, YYYY-MM-DD, DD/MM/YYYY, etc.)
 * into a pure UTC midnight Date object (00:00:00.000Z) with zero timezone offset drift.
 */
function parseCalendarDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  const str = String(raw).trim();
  if (!str || ['null', 'undefined', 'n/a', 'na', 'none', 'nil', '-', '0', 'invalid date'].includes(str.toLowerCase())) {
    return null;
  }

  // 1. If raw is already a Date object
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate(), 0, 0, 0, 0));
  }

  // 2. If raw is an Excel serial number
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

  // 5. Fallback ISO or standard Date string (e.g. 'Tue Aug 25 2026 03:00:00 GMT+0300')
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) {
    if (str.includes('Z')) {
      return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 0, 0, 0, 0));
    }
    return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, 0, 0, 0));
  }

  return null;
}

/**
 * Snaps a date that was shifted by timezone offset back to the intended calendar day UTC midnight.
 */
function snapShiftedDate(d, serverTzHours = 3) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;

  // If already at clean UTC midnight:
  if (dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0 && dt.getUTCMilliseconds() === 0) {
    return dt;
  }

  // Adjust shifted timestamp back by adding server tz offset + small 60s epsilon
  const adjusted = new Date(dt.getTime() + (serverTzHours * 3600 * 1000) + 60000);
  return new Date(Date.UTC(adjusted.getUTCFullYear(), adjusted.getUTCMonth(), adjusted.getUTCDate(), 0, 0, 0, 0));
}

// Compute maturity date given paymentDate and settingsMap
function computeMaturityDate(paymentDate, settingsMap) {
  const dayOfWeek = paymentDate.getUTCDay();
  const offsetDays = settingsMap[dayOfWeek] !== undefined ? settingsMap[dayOfWeek] : 2;
  const maturityDate = new Date(paymentDate);
  maturityDate.setUTCDate(maturityDate.getUTCDate() + offsetDays);
  return maturityDate;
}

async function getSettingsMap() {
  const settings = await MaturitySetting.find({});
  const map = {};
  settings.forEach(s => {
    map[s.dayOfWeek] = s.offsetDays;
  });
  return map;
}

// Print Help
function printHelp() {
  console.log(`
===========================================================
 Payment Dates Correction Script
===========================================================
Normalizes payment received dates and maturity dates to exact
UTC Midnight (00:00:00.000Z) without timezone shifts.

Usage:
  node scripts/fix-payment-dates.js [options]

Modes:
  --files <file1> <file2> ...   Re-parse one or more CSV or Excel files
  --dir <folder>                Scan directory for CSV/Excel files and re-parse
  --from-history                Normalize dates recorded in PaymentUploadHistory
  --normalize-db                Directly snap existing shifted timestamps in MongoDB

Options:
  --dry-run                     Preview changes without writing to MongoDB
  --tz-offset <hours>           Server timezone offset (default: 3 for EAT)
  --help, -h                    Show this help screen

Examples:
  # Preview re-parsing a specific CSV file
  node scripts/fix-payment-dates.js --files ./sample-payments.csv --dry-run

  # Apply date fixes from a CSV file
  node scripts/fix-payment-dates.js --files ./sample-payments.csv

  # Scan a folder of upload documents and apply fixes
  node scripts/fix-payment-dates.js --dir ./uploads

  # Normalize all existing database records directly
  node scripts/fix-payment-dates.js --normalize-db
===========================================================
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const isDryRun = args.includes('--dry-run');
  let tzOffset = 3;
  const tzIdx = args.indexOf('--tz-offset');
  if (tzIdx !== -1 && args[tzIdx + 1]) {
    tzOffset = parseFloat(args[tzIdx + 1]) || 3;
  }

  let mongoUri = process.env.MONGO_URI;
  const uriIdx = args.indexOf('--mongo-uri');
  if (uriIdx !== -1 && args[uriIdx + 1]) {
    mongoUri = args[uriIdx + 1];
  }

  console.log('----------------------------------------------------');
  console.log(`Mode: ${isDryRun ? '🔍 DRY RUN (No changes will be saved)' : '🚀 LIVE RUN (Changes will be saved to MongoDB)'}`);
  console.log(`Server Timezone Offset: UTC+${tzOffset}`);
  console.log('----------------------------------------------------');

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB database.');

  const settingsMap = await getSettingsMap();

  let filesToProcess = [];

  // 1. Check for --files
  const filesIdx = args.indexOf('--files');
  if (filesIdx !== -1) {
    for (let i = filesIdx + 1; i < args.length; i++) {
      if (args[i].startsWith('--')) break;
      filesToProcess.push(args[i]);
    }
  }

  // 2. Check for --dir
  const dirIdx = args.indexOf('--dir');
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    const targetDir = path.resolve(args[dirIdx + 1]);
    if (fs.existsSync(targetDir)) {
      const entries = fs.readdirSync(targetDir);
      for (const entry of entries) {
        if (entry.endsWith('.csv') || entry.endsWith('.xlsx') || entry.endsWith('.xls')) {
          filesToProcess.push(path.join(targetDir, entry));
        }
      }
    } else {
      console.warn(`Directory not found: ${targetDir}`);
    }
  }

  // Mode: From Files
  if (filesToProcess.length > 0) {
    console.log(`\nProcessing ${filesToProcess.length} file(s)...`);
    let totalRowsProcessed = 0;
    let totalUpdated = 0;
    let totalUnmatched = 0;

    for (const filePath of filesToProcess) {
      if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}`);
        continue;
      }
      console.log(`\nReading file: ${filePath}`);
      const workbook = XLSX.readFile(filePath, { cellDates: false });
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

      if (rows.length === 0) {
        console.log('  File is empty, skipping.');
        continue;
      }

      for (const row of rows) {
        totalRowsProcessed++;
        let name = null;
        let amountRaw = null;
        let dateRaw = null;

        for (const key of Object.keys(row)) {
          const lower = key.trim().toLowerCase();
          if (isNameKey(lower)) name = String(row[key]).trim();
          else if (isAmountKey(lower)) amountRaw = row[key];
          else if (isDateKey(lower)) dateRaw = row[key];
        }

        // Skip rows that failed during original upload
        const statusVal = row.Status || row.status;
        if (statusVal && String(statusVal).trim().toLowerCase() === 'failed') {
          continue;
        }

        if (!name || !dateRaw) continue;

        const paymentDate = parseCalendarDate(dateRaw);
        if (!paymentDate) {
          console.warn(`  [Row ${totalRowsProcessed}] Invalid date for "${name}": ${dateRaw}`);
          continue;
        }

        const maturityDate = computeMaturityDate(paymentDate, settingsMap);
        const payoutName = await PayoutName.findOne({ nameLower: name.toLowerCase() });

        if (!payoutName) {
          totalUnmatched++;
          console.log(`  [Unmatched] Payout name not in DB: "${name}"`);
          continue;
        }

        const oldReceived = payoutName.paymentReceivedDate ? payoutName.paymentReceivedDate.toISOString() : 'null';
        const oldMaturity = payoutName.maturityDate ? payoutName.maturityDate.toISOString() : 'null';
        const newReceived = paymentDate.toISOString();
        const newMaturity = maturityDate.toISOString();

        const needsUpdate = oldReceived !== newReceived || oldMaturity !== newMaturity;

        if (needsUpdate) {
          totalUpdated++;
          console.log(`  ✓ Update "${payoutName.name}":`);
          console.log(`     Received: ${oldReceived} -> ${newReceived}`);
          console.log(`     Maturity: ${oldMaturity} -> ${newMaturity}`);

          if (!isDryRun) {
            payoutName.paymentReceivedDate = paymentDate;
            payoutName.maturityDate = maturityDate;
            if (payoutName.paymentStatus === 'not_received') {
              payoutName.paymentStatus = 'received';
            }
            await payoutName.save();

            // Also update any matching PayoutNameLog
            await PayoutNameLog.updateMany(
              { payoutName: payoutName._id, action: 'payment_received' },
              { $set: { paymentDate: paymentDate, maturityDate: maturityDate } }
            );
          }
        } else {
          console.log(`  • "${payoutName.name}" already clean (${newReceived})`);
        }
      }
    }

    console.log('\n================ Summary ================');
    console.log(`Total Rows Examined:   ${totalRowsProcessed}`);
    console.log(`Total Payouts Updated: ${totalUpdated}`);
    console.log(`Unmatched Names:       ${totalUnmatched}`);
    console.log('=========================================');
  }

  // Mode: From PaymentUploadHistory
  if (args.includes('--from-history')) {
    console.log('\nProcessing records from PaymentUploadHistory...');
    const histories = await PaymentUploadHistory.find().sort({ createdAt: 1 });
    let historyItemsProcessed = 0;
    let historyUpdated = 0;

    for (const h of histories) {
      if (!h.items || h.items.length === 0) continue;
      let historyNeedsSave = false;

      for (const item of h.items) {
        historyItemsProcessed++;
        if (!item.name || !item.date) continue;

        const paymentDate = parseCalendarDate(item.date);
        if (!paymentDate) continue;

        const maturityDate = computeMaturityDate(paymentDate, settingsMap);
        const cleanDateStr = paymentDate.toISOString().split('T')[0];

        // Update history item date string if shifted/verbose
        if (item.date !== cleanDateStr) {
          if (!isDryRun) {
            item.date = cleanDateStr;
            historyNeedsSave = true;
          }
        }

        const payoutName = await PayoutName.findOne({ nameLower: item.name.toLowerCase() });
        if (payoutName) {
          const oldReceived = payoutName.paymentReceivedDate ? payoutName.paymentReceivedDate.toISOString() : 'null';
          const newReceived = paymentDate.toISOString();
          const oldMaturity = payoutName.maturityDate ? payoutName.maturityDate.toISOString() : 'null';
          const newMaturity = maturityDate.toISOString();

          if (oldReceived !== newReceived || oldMaturity !== newMaturity) {
            historyUpdated++;
            console.log(`  ✓ Update "${payoutName.name}" from history:`);
            console.log(`     Received: ${oldReceived} -> ${newReceived}`);
            console.log(`     Maturity: ${oldMaturity} -> ${newMaturity}`);

            if (!isDryRun) {
              payoutName.paymentReceivedDate = paymentDate;
              payoutName.maturityDate = maturityDate;
              if (payoutName.paymentStatus === 'not_received') {
                payoutName.paymentStatus = 'received';
              }
              await payoutName.save();
            }
          }
        }
      }

      if (historyNeedsSave && !isDryRun) {
        await h.save();
      }
    }

    console.log('\n========= History Sync Summary ==========');
    console.log(`Total History Items:   ${historyItemsProcessed}`);
    console.log(`Total Payouts Updated: ${historyUpdated}`);
    console.log('=========================================');
  }

  // Mode: Direct DB Normalization
  if (args.includes('--normalize-db')) {
    console.log('\nScanning PayoutName collection for shifted timestamps...');
    const names = await PayoutName.find({ paymentReceivedDate: { $ne: null } });
    let dbChecked = 0;
    let dbUpdated = 0;

    for (const pn of names) {
      dbChecked++;
      const currentReceived = pn.paymentReceivedDate;
      const currentMaturity = pn.maturityDate;

      const snappedReceived = snapShiftedDate(currentReceived, tzOffset);
      if (!snappedReceived) continue;

      const snappedMaturity = computeMaturityDate(snappedReceived, settingsMap);

      const oldRecISO = currentReceived.toISOString();
      const newRecISO = snappedReceived.toISOString();
      const oldMatISO = currentMaturity ? currentMaturity.toISOString() : 'null';
      const newMatISO = snappedMaturity.toISOString();

      if (oldRecISO !== newRecISO || oldMatISO !== newMatISO) {
        dbUpdated++;
        console.log(`  ✓ Correcting "${pn.name}":`);
        console.log(`     Received: ${oldRecISO} -> ${newRecISO}`);
        console.log(`     Maturity: ${oldMatISO} -> ${newMatISO}`);

        if (!isDryRun) {
          pn.paymentReceivedDate = snappedReceived;
          pn.maturityDate = snappedMaturity;
          await pn.save();

          await PayoutNameLog.updateMany(
            { payoutName: pn._id, action: 'payment_received' },
            { $set: { paymentDate: snappedReceived, maturityDate: snappedMaturity } }
          );
        }
      }
    }

    console.log('\n======= DB Normalization Summary ========');
    console.log(`Total Records Checked: ${dbChecked}`);
    console.log(`Total Records Updated: ${dbUpdated}`);
    console.log('=========================================');
  }

  await mongoose.disconnect();
  console.log('\nDone! Disconnected from MongoDB.\n');
}

main().catch(err => {
  console.error('Migration script error:', err);
  process.exit(1);
});
