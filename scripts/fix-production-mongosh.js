/**
 * Run this directly inside mongosh connected to your production database:
 * 
 * mongosh "mongodb://..." fix-production-mongosh.js
 * 
 * OR paste the contents directly into your mongosh shell prompt.
 */

print("=================================================");
print(" Starting Payment Date Correction on Production");
print("=================================================");

// 1. The 24 successful names from the 23 September 2026 upload report
const targetNames = [
  "MIKHAIL ALEXANDROVICH POPOV",
  "PAUL WESLEY ROBINSON",
  "AMELIA ISABELLE GRAHAM",
  "MATHEW SESSUM",
  "THOMAS GRACE MARTIN",
  "DMITRI NIKOLAEVICH VOLOKOV",
  "ISABELLA MARIE THOMPSON",
  "CAMILA ANTHONY HALL",
  "TOBIAS FRIEDRICH KRAUS",
  "SOPHIE MAE CLARK",
  "JACK WILLIAM HARRIS",
  "THOMAS BROOKE THOMAS",
  "DAISY ROSE WALKER",
  "LARA MARIA FRITZ",
  "ELISE LUISE SIMON",
  "HENRY THOMAS ROBINSON",
  "MARLENE CLARA JUNG",
  "ARTEM SERGEEVICH MOROZOV",
  "LENA CLARA WEGNER",
  "MORITZ JOHANN ECKERT",
  "CODY KENNEDY",
  "WILLIAM GEORGE HALL",
  "THEO BENJAMIN KING",
  "LUCY ANNE ALLEN"
];

// Step 1: Update the 24 names specifically to 23/09/2026 and maturity 25/09/2026
const resSpecific = db.payoutnames.updateMany(
  { name: { $in: targetNames } },
  {
    $set: {
      paymentReceivedDate: ISODate("2026-09-23T00:00:00.000Z"),
      maturityDate: ISODate("2026-09-25T00:00:00.000Z")
    }
  }
);
print(`\n✓ Explicitly updated ${resSpecific.modifiedCount} payout names for 23 September 2026.`);

// Step 2: Update the audit logs for these names
const payoutIds = db.payoutnames.find({ name: { $in: targetNames } }).map(p => p._id);
const resLogs = db.payoutnamelogs.updateMany(
  { payoutName: { $in: payoutIds }, action: "payment_received" },
  {
    $set: {
      paymentDate: ISODate("2026-09-23T00:00:00.000Z"),
      maturityDate: ISODate("2026-09-25T00:00:00.000Z")
    }
  }
);
print(`✓ Updated ${resLogs.modifiedCount} corresponding audit log entries.`);

// Step 3: General sweep for ANY other names uploaded prior to the fix with shifted hours (e.g. 21:00 or 20:59)
const offsetMap = { 0: 1, 1: 2, 2: 2, 3: 2, 4: 2, 5: 4, 6: 3 };
let sweptCount = 0;

db.payoutnames.find({ paymentReceivedDate: { $ne: null } }).forEach(doc => {
  const d = doc.paymentReceivedDate;
  if (d && (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0)) {
    // Add 3 hours (180 mins) + 1 min to recover original local calendar day
    const adjusted = new Date(d.getTime() + (3 * 3600 * 1000) + 60000);
    const cleanReceived = new Date(Date.UTC(adjusted.getUTCFullYear(), adjusted.getUTCMonth(), adjusted.getUTCDate(), 0, 0, 0, 0));
    const dayOfWeek = cleanReceived.getUTCDay();
    const offset = offsetMap[dayOfWeek] || 2;
    const cleanMaturity = new Date(cleanReceived);
    cleanMaturity.setUTCDate(cleanMaturity.getUTCDate() + offset);

    db.payoutnames.updateOne(
      { _id: doc._id },
      { $set: { paymentReceivedDate: cleanReceived, maturityDate: cleanMaturity } }
    );

    db.payoutnamelogs.updateMany(
      { payoutName: doc._id, action: "payment_received" },
      { $set: { paymentDate: cleanReceived, maturityDate: cleanMaturity } }
    );

    sweptCount++;
    print(`  • Swept & fixed shifted date for "${doc.name}": Received -> ${cleanReceived.toISOString()}`);
  }
});

print(`\n✓ General sweep complete: checked all names, fixed ${sweptCount} additional shifted records.`);

// Verification check on Lucy
const lucy = db.payoutnames.findOne({ name: "LUCY ANNE ALLEN" });
print("\n--- Verification on LUCY ANNE ALLEN ---");
print(`Name:          ${lucy.name}`);
print(`Received Date: ${lucy.paymentReceivedDate.toISOString()}`);
print(`Maturity Date: ${lucy.maturityDate.toISOString()}`);
print("=================================================");
