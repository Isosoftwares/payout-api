const mongoose = require("mongoose");
const PayoutName = require("../models/PayoutName");
const PayoutNameLog = require("../models/PayoutNameLog");
const User = require("../models/User");
const Subaccount = require("../models/Subaccount");

// @desc    Get daily report for payments received or maturing on a specific date
// @route   GET /api/reports/daily
// @access  Private (Admin & Client)
const getDailyReport = async (req, res) => {
  try {
    const {
      date,
      dateType = "received", // 'received' or 'maturity'
      clientId,
      paymentStatus,
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const isExport = req.query.all === "true" || req.query.download === "true";
    let limit = parseInt(req.query.limit) || 100;
    if (isExport) {
      limit = 10000;
    } else {
      if (limit < 100) limit = 100;
      if (limit > 1000) limit = 1000;
    }

    // Determine target date string (defaults to today YYYY-MM-DD UTC)
    const targetDateStr = date || new Date().toISOString().split("T")[0];
    const [year, month, day] = targetDateStr.split("-").map(Number);

    if (!year || !month || !day) {
      return res.status(400).json({ message: "Invalid date format. Expected YYYY-MM-DD." });
    }

    // Define UTC day boundaries
    const startOfDay = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const endOfDay = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

    const query = {};

    // Helper to build ID matches for ObjectId and string so both MongoDB aggregation and find work
    const toIdMatches = (id) => {
      const matches = [];
      if (mongoose.Types.ObjectId.isValid(id)) {
        matches.push(new mongoose.Types.ObjectId(id));
      }
      matches.push(String(id));
      return matches;
    };

    // Role-based client constraint
    if (req.user.role === "client") {
      const clientMatches = toIdMatches(req.user.id);
      const subaccounts = await Subaccount.find({ clientId: { $in: clientMatches } }).select("_id");
      const subaccountIds = subaccounts.map((s) => s._id);

      if (subaccountIds.length > 0) {
        query.$or = [
          { allocatedTo: { $in: clientMatches } },
          { claimedForSubaccount: { $in: subaccountIds } },
        ];
      } else {
        query.allocatedTo = { $in: clientMatches };
      }
    } else if (req.user.role === "subaccount") {
      const subMatches = toIdMatches(req.user.id);
      query.claimedForSubaccount = { $in: subMatches };
    } else if (req.user.role === "admin") {
      if (clientId && clientId !== "all") {
        const clientMatches = toIdMatches(clientId);
        const subaccounts = await Subaccount.find({ clientId: { $in: clientMatches } }).select("_id");
        const subaccountIds = subaccounts.map((s) => s._id);

        if (subaccountIds.length > 0) {
          query.$or = [
            { allocatedTo: { $in: clientMatches } },
            { claimedForSubaccount: { $in: subaccountIds } },
          ];
        } else {
          query.allocatedTo = { $in: clientMatches };
        }
      }
    }

    // Date type filter
    if (dateType === "maturity") {
      query.maturityDate = { $gte: startOfDay, $lte: endOfDay };
    } else {
      // Default: 'received'
      query.paymentReceivedDate = { $gte: startOfDay, $lte: endOfDay };
    }

    // Optional payment status filter
    if (paymentStatus && paymentStatus !== "all") {
      query.paymentStatus = paymentStatus;
    }

    // Search filter (by payout name, account number, or routing number)
    const search = req.query.search?.trim();
    if (search) {
      const searchOr = [
        { name: { $regex: search, $options: "i" } },
        { accountNumber: { $regex: search, $options: "i" } },
        { routingNumber: { $regex: search, $options: "i" } },
      ];

      if (query.$or) {
        const roleOr = query.$or;
        delete query.$or;
        query.$and = [
          { $or: roleOr },
          { $or: searchOr },
        ];
      } else {
        query.$or = searchOr;
      }
    }

    // Calculate totals across ALL matching records using aggregation
    const totalsAggregation = await PayoutName.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalCount: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    const totalCount = totalsAggregation[0]?.totalCount || 0;
    const totalAmount = totalsAggregation[0]?.totalAmount || 0;

    // Fetch paginated records
    const rawRecords = await PayoutName.find(query)
      .populate("allocatedTo", "email profile")
      .populate("claimedForSubaccount", "username")
      .sort(dateType === "maturity" ? { maturityDate: -1, createdAt: -1 } : { paymentReceivedDate: -1, createdAt: -1 })
      .skip(isExport ? 0 : (page - 1) * limit)
      .limit(limit);

    // Enrich records with paymentReceivedCount
    let records = rawRecords;
    if (rawRecords.length > 0) {
      try {
        const ids = rawRecords.map((p) => p._id);
        const logCounts = await PayoutNameLog.aggregate([
          {
            $match: {
              payoutName: { $in: ids },
              action: { $in: ["payment_received", "payment_reversed"] },
            },
          },
          {
            $group: {
              _id: "$payoutName",
              receivedCount: {
                $sum: { $cond: [{ $eq: ["$action", "payment_received"] }, 1, 0] },
              },
              reversedCount: {
                $sum: { $cond: [{ $eq: ["$action", "payment_reversed"] }, 1, 0] },
              },
            },
          },
        ]);

        const countMap = {};
        for (const item of logCounts) {
          const net = Math.max(0, item.receivedCount - item.reversedCount);
          countMap[item._id.toString()] = net;
        }

        records = rawRecords.map((p) => {
          const obj = p.toObject ? p.toObject() : { ...p };
          const cnt = countMap[obj._id.toString()] || 0;
          obj.paymentReceivedCount = cnt;
          obj.hasMultiplePayments = cnt > 1;
          return obj;
        });
      } catch (enrichErr) {
        console.error("Error enriching daily report records:", enrichErr);
      }
    }

    res.status(200).json({
      success: true,
      data: {
        date: targetDateStr,
        dateType,
        totalCount,
        totalAmount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit) || 1,
        records,
      },
    });
  } catch (error) {
    console.error("Daily report error:", error);
    res.status(500).json({ message: "Server error generating daily report", error: error.message });
  }
};

module.exports = {
  getDailyReport,
};
