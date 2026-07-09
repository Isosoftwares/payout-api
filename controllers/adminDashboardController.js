// controllers/adminDashboardController.js
const User = require("../models/User");
const Transaction = require("../models/Payment");
const History = require("../models/History");
const Task = require("../models/Task");
const Configuration = require("../models/Configuration");
const { default: axios } = require("axios");

// Error handling wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Response formatter
const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success,
  data,
  message,
  statusCode,
});

// ================================
// DASHBOARD OVERVIEW
// ================================

// Get dashboard overview statistics
const getDashboardOverview = asyncHandler(async (req, res) => {
  try {
    // Get current date ranges
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thisYear = new Date(now.getFullYear(), 0, 1);

    // User Statistics
    const userStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          activeUsers: { $sum: { $cond: ["$isActive", 1, 0] } },
          adminUsers: { $sum: { $cond: [{ $eq: ["$role", "admin"] }, 1, 0] } },
          clientUsers: {
            $sum: { $cond: [{ $eq: ["$role", "client"] }, 1, 0] },
          },
          totalBalance: { $sum: "$balance" },
          averageBalance: { $avg: "$balance" },
          newUsersToday: {
            $sum: { $cond: [{ $gte: ["$createdAt", today] }, 1, 0] },
          },
          newUsersThisMonth: {
            $sum: { $cond: [{ $gte: ["$createdAt", thisMonth] }, 1, 0] },
          },
        },
      },
    ]);

    // Transaction Statistics
    const transactionStats = await Transaction.aggregate([
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "finished"] },
                    {
                      $in: [
                        "$transactionType",
                        ["crypto_payment", "admin_deposit"],
                      ],
                    },
                  ],
                },
                "$actuallyPaid",
                0,
              ],
            },
          },
          totalSystemCharges: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "finished"] },
                    { $eq: ["$transactionType", "system_deduction"] },
                  ],
                },
                "$priceAmount",
                0,
              ],
            },
          },
          todayRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$createdAt", today] },
                    { $eq: ["$status", "finished"] },
                    {
                      $in: [
                        "$transactionType",
                        ["crypto_payment", "admin_deposit"],
                      ],
                    },
                  ],
                },
                "$actuallyPaid",
                0,
              ],
            },
          },
          thisMonthRevenue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gte: ["$createdAt", thisMonth] },
                    { $eq: ["$status", "finished"] },
                    {
                      $in: [
                        "$transactionType",
                        ["crypto_payment", "admin_deposit"],
                      ],
                    },
                  ],
                },
                "$actuallyPaid",
                0,
              ],
            },
          },
          activeTransactions: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$status",
                    [
                      "waiting",
                      "confirming",
                      "confirmed",
                      "sending",
                      "partially_paid",
                    ],
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    // Lookup History Statistics
    const lookupStats = await History.aggregate([
      {
        $group: {
          _id: null,
          totalLookups: { $sum: 1 },
          singleLookups: {
            $sum: { $cond: [{ $eq: ["$requestType", "single"] }, 1, 0] },
          },
          csvLookups: {
            $sum: { $cond: [{ $eq: ["$requestType", "document"] }, 1, 0] },
          },
          completedLookups: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$singleRequest.status", "completed"] },
                    { $eq: ["$documentRequest.status", "completed"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          todayLookups: {
            $sum: { $cond: [{ $gte: ["$createdAt", today] }, 1, 0] },
          },
          thisMonthLookups: {
            $sum: { $cond: [{ $gte: ["$createdAt", thisMonth] }, 1, 0] },
          },
        },
      },
    ]);

    // Task Usage Statistics
    const taskUsage = await History.aggregate([
      {
        $lookup: {
          from: "tasks",
          localField: "taskId",
          foreignField: "_id",
          as: "task",
        },
      },
      { $unwind: "$task" },
      {
        $group: {
          _id: "$taskId",
          taskName: { $first: "$task.name" },
          usageCount: { $sum: 1 },
          totalRevenue: { $sum: "$totalCost" },
        },
      },
      { $sort: { usageCount: -1 } },
      { $limit: 5 },
    ]);

    const accountBalance = await axios.get(
      process.env.FOREST_API_BASE_URL + "/getMe",
      {
        headers: {
          Authorization: `Bearer ${process.env.FOREST_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const overview = {
      users: userStats[0] || {
        totalUsers: 0,
        activeUsers: 0,
        adminUsers: 0,
        clientUsers: 0,
        totalBalance: 0,
        averageBalance: 0,
        newUsersToday: 0,
        newUsersThisMonth: 0,
      },
      transactions: transactionStats[0] || {
        totalTransactions: 0,
        totalRevenue: 0,
        totalSystemCharges: 0,
        todayRevenue: 0,
        thisMonthRevenue: 0,
        activeTransactions: 0,
      },
      lookups: lookupStats[0] || {
        totalLookups: 0,
        singleLookups: 0,
        csvLookups: 0,
        completedLookups: 0,
        todayLookups: 0,
        thisMonthLookups: 0,
      },
      topTasks: taskUsage,
      accountBalance: accountBalance?.data?.api_balance || 0,
    };

    const response = formatResponse(true, overview);
    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("Dashboard overview error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching dashboard overview",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

// ================================
// FINANCIAL ANALYTICS
// ================================

// Get revenue analytics
const getRevenueAnalytics = asyncHandler(async (req, res) => {
  const { period = "30days" } = req.query;

  try {
    let dateRange;
    let groupBy;

    switch (period) {
      case "7days":
        dateRange = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        groupBy = {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          day: { $dayOfMonth: "$createdAt" },
        };
        break;
      case "30days":
        dateRange = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        groupBy = {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          day: { $dayOfMonth: "$createdAt" },
        };
        break;
      case "12months":
        dateRange = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        groupBy = {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
        };
        break;
      default:
        dateRange = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        groupBy = {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          day: { $dayOfMonth: "$createdAt" },
        };
    }

    // Revenue over time
    const revenueOverTime = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: dateRange },
          status: "finished",
          transactionType: { $in: ["crypto_payment", "admin_deposit"] },
        },
      },
      {
        $group: {
          _id: groupBy,
          revenue: { $sum: "$actuallyPaid" },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // System charges over time
    const systemCharges = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: dateRange },
          status: "finished",
          transactionType: "system_deduction",
        },
      },
      {
        $group: {
          _id: groupBy,
          charges: { $sum: "$priceAmount" },
          lookupCount: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // Revenue by transaction type
    const revenueByType = await Transaction.aggregate([
      {
        $match: {
          createdAt: { $gte: dateRange },
          status: "finished",
        },
      },
      {
        $group: {
          _id: "$transactionType",
          total: { $sum: "$actuallyPaid" },
          count: { $sum: 1 },
        },
      },
    ]);

    const response = formatResponse(true, {
      period,
      revenueOverTime,
      systemCharges,
      revenueByType,
    });

    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("Revenue analytics error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching revenue analytics",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

// ================================
// USER ANALYTICS
// ================================

// Get user analytics
const getUserAnalytics = asyncHandler(async (req, res) => {
  try {
    // User registration over time (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const userRegistrations = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
          },
          registrations: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    // Top users by balance
    const topUsersByBalance = await User.find({
      role: "client",
      isActive: true,
    })
      .select(
        "email balance profile.firstName profile.lastName profile.company"
      )
      .sort({ balance: -1 })
      .limit(10);

    // Top users by spending (based on system deductions)
    const topUsersBySpending = await Transaction.aggregate([
      {
        $match: {
          transactionType: "system_deduction",
          status: "finished",
        },
      },
      {
        $group: {
          _id: "$userId",
          totalSpent: { $sum: "$priceAmount" },
          lookupCount: { $sum: 1 },
        },
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          email: "$user.email",
          firstName: "$user.profile.firstName",
          lastName: "$user.profile.lastName",
          company: "$user.profile.company",
          totalSpent: 1,
          lookupCount: 1,
        },
      },
    ]);

    // User activity distribution
    const userActivity = await User.aggregate([
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 },
          activeCount: { $sum: { $cond: ["$isActive", 1, 0] } },
          totalBalance: { $sum: "$balance" },
        },
      },
    ]);

    const response = formatResponse(true, {
      userRegistrations,
      topUsersByBalance,
      topUsersBySpending,
      userActivity,
    });

    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("User analytics error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching user analytics",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

// ================================
// TASK ANALYTICS
// ================================

// Get task analytics
const getTaskAnalytics = asyncHandler(async (req, res) => {
  try {
    // Task usage statistics
    const taskUsage = await History.aggregate([
      {
        $lookup: {
          from: "tasks",
          localField: "taskId",
          foreignField: "_id",
          as: "task",
        },
      },
      { $unwind: "$task" },
      {
        $group: {
          _id: "$taskId",
          taskName: { $first: "$task.name" },
          pricePerRequest: { $first: "$task.pricePerRequest" },
          totalUsage: { $sum: 1 },
          totalRevenue: { $sum: "$totalCost" },
          singleLookups: {
            $sum: { $cond: [{ $eq: ["$requestType", "single"] }, 1, 0] },
          },
          csvLookups: {
            $sum: { $cond: [{ $eq: ["$requestType", "document"] }, 1, 0] },
          },
          successfulLookups: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$singleRequest.status", "completed"] },
                    { $eq: ["$documentRequest.status", "completed"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          successRate: {
            $multiply: [
              { $divide: ["$successfulLookups", "$totalUsage"] },
              100,
            ],
          },
        },
      },
      { $sort: { totalUsage: -1 } },
    ]);

    // Task usage over time (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const taskUsageOverTime = await History.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $lookup: {
          from: "tasks",
          localField: "taskId",
          foreignField: "_id",
          as: "task",
        },
      },
      { $unwind: "$task" },
      {
        $group: {
          _id: {
            taskName: "$task.name",
            date: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
              day: { $dayOfMonth: "$createdAt" },
            },
          },
          usage: { $sum: 1 },
        },
      },
      { $sort: { "_id.date.year": 1, "_id.date.month": 1, "_id.date.day": 1 } },
    ]);

    // Task performance metrics
    const taskPerformance = await Task.aggregate([
      {
        $lookup: {
          from: "histories",
          localField: "_id",
          foreignField: "taskId",
          as: "histories",
        },
      },
      {
        $addFields: {
          totalUsage: { $size: "$histories" },
          avgProcessingTime: { $avg: "$histories.processingTime" },
        },
      },
      {
        $project: {
          name: 1,
          pricePerRequest: 1,
          isActive: 1,
          totalUsage: 1,
          avgProcessingTime: 1,
        },
      },
      { $sort: { totalUsage: -1 } },
    ]);

    const response = formatResponse(true, {
      taskUsage,
      taskUsageOverTime,
      taskPerformance,
    });

    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("Task analytics error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching task analytics",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

// ================================
// SYSTEM MONITORING
// ================================

// Get system status
const getSystemStatus = asyncHandler(async (req, res) => {
  try {
    // Database statistics
    const collections = await Promise.all([
      User.countDocuments(),
      Transaction.countDocuments(),
      History.countDocuments(),
      Task.countDocuments(),
      Configuration.countDocuments(),
    ]);

    // Recent activity (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentActivity = {
      newUsers: await User.countDocuments({ createdAt: { $gte: yesterday } }),
      newTransactions: await Transaction.countDocuments({
        createdAt: { $gte: yesterday },
      }),
      newLookups: await History.countDocuments({
        createdAt: { $gte: yesterday },
      }),
      pendingTransactions: await Transaction.countDocuments({
        status: {
          $in: [
            "waiting",
            "confirming",
            "confirmed",
            "sending",
            "partially_paid",
          ],
        },
      }),
      processingJobs: await History.countDocuments({
        $or: [
          { "singleRequest.status": "pending" },
          { "documentRequest.status": { $in: ["pending", "processing"] } },
        ],
      }),
    };

    // System configuration
    const systemConfig = await Configuration.find()
      .select("key value description")
      .sort({ key: 1 });

    // API health metrics (simulated - in real implementation, these would come from monitoring)
    const apiHealth = {
      forestApiStatus: "healthy", // Would check actual API status
      databaseStatus: "healthy",
      queueStatus: "healthy",
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      nodeVersion: process.version,
    };

    const response = formatResponse(true, {
      collections: {
        users: collections[0],
        transactions: collections[1],
        histories: collections[2],
        tasks: collections[3],
        configurations: collections[4],
      },
      recentActivity,
      systemConfig: systemConfig.slice(0, 5), // First 5 configs
      apiHealth,
    });

    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("System status error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching system status",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

// ================================
// RECENT ACTIVITY
// ================================

// Get recent activity feed
const getRecentActivity = asyncHandler(async (req, res) => {
  const { limit = 5 } = req.query;

  try {
    // Recent transactions
    const recentTransactions = await Transaction.find()
      .populate("userId", "email profile.firstName profile.lastName")
      .populate("adminUserId", "email")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) / 2)
      .select(
        "paymentId transactionType priceAmount status createdAt description"
      );

    // Recent lookups
    const recentLookups = await History.find()
      .populate("clientId", "email profile.firstName profile.lastName")
      .populate("taskId", "name pricePerRequest")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) / 2)
      .select(
        "requestType totalCost createdAt singleRequest.status documentRequest.status"
      );

    // Recent user registrations
    const recentUsers = await User.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("email role createdAt profile.firstName profile.lastName");

    // Combine and sort all activities
    const activities = [
      ...recentTransactions.map((t) => ({
        type: "transaction",
        id: t._id,
        timestamp: t.createdAt,
        description: `${t.transactionType} transaction: $${t.priceAmount}`,
        user: t.userId,
        status: t.status,
        data: t,
      })),
      ...recentLookups.map((l) => ({
        type: "lookup",
        id: l._id,
        timestamp: l.createdAt,
        description: `${l.requestType} lookup using ${l.taskId?.name}`,
        user: l.clientId,
        status: l.singleRequest?.status || l.documentRequest?.status,
        data: l,
      })),
      ...recentUsers.map((u) => ({
        type: "user_registration",
        id: u._id,
        timestamp: u.createdAt,
        description: `New ${u.role} user registered`,
        user: u,
        status: "completed",
        data: u,
      })),
    ]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit));

    const response = formatResponse(true, activities);
    res.status(response.statusCode).json(response);
  } catch (error) {
    console.error("Recent activity error:", error);
    const response = formatResponse(
      false,
      null,
      "Error fetching recent activity",
      500
    );
    res.status(response.statusCode).json(response);
  }
});

module.exports = {
  getDashboardOverview,
  getRevenueAnalytics,
  getUserAnalytics,
  getTaskAnalytics,
  getSystemStatus,
  getRecentActivity,
};
