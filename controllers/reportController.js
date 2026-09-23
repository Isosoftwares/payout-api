const PayoutName = require("../models/PayoutName");
const User = require("../models/User");

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

    // Role-based client constraint
    if (req.user.role === "client") {
      query.allocatedTo = req.user.id;
    } else if (req.user.role === "subaccount") {
      query.claimedForSubaccount = req.user.id;
    } else if (req.user.role === "admin") {
      if (clientId && clientId !== "all") {
        query.allocatedTo = clientId;
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
    const records = await PayoutName.find(query)
      .populate("allocatedTo", "email profile")
      .populate("claimedForSubaccount", "username")
      .sort(dateType === "maturity" ? { maturityDate: -1, createdAt: -1 } : { paymentReceivedDate: -1, createdAt: -1 })
      .skip(isExport ? 0 : (page - 1) * limit)
      .limit(limit);

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
