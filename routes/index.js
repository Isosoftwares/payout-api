// routes/index.js
const express = require("express");
const router = express.Router();

// Import route modules
const authRoutes = require("./authRoutes");
const userRoutes = require("./userRoutes");
const paymentRoutes = require("./paymentRoutes");
const supportRoutes = require("./supportRoutes");
const virtualAccountRoutes = require("./virtualAccountRoutes");
const transactionRoutes = require("./transactionRoutes");
const notificationRoutes = require("./notificationRoutes");

// Health check endpoint
router.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Lookup API System is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Documentation endpoint
// router.get('/docs', (req, res) => {
//   res.status(200).json({
//     success: true,
//     message: 'Forest Lookup API Documentation',
//     version: '1.0.0',
//     endpoints: {
//       authentication: {
//         login: 'POST /api/auth/login',
//         register: 'POST /api/auth/register',
//         refresh: 'POST /api/auth/refresh',
//         logout: 'POST /api/auth/logout',
//         verify: 'POST /api/auth/verify',
//         changePassword: 'POST /api/auth/change-password'
//       },
//       users: {
//         profile: 'GET /api/users/profile',
//         updateProfile: 'PUT /api/users/profile',
//         balance: 'GET /api/users/balance',
//         adminManagement: '/api/users/admin/*'
//       },
//       tasks: {
//         adminManagement: '/api/admin/tasks/*'
//       },
//       configurations: {
//         adminManagement: '/api/admin/config/*'
//       },
//       lookups: {
//         availableTasks: 'GET /api/lookup/tasks',
//         singleLookup: 'POST /api/lookup/single',
//         csvLookup: 'POST /api/lookup/csv'
//       },
//       history: {
//         list: 'GET /api/history',
//         statistics: 'GET /api/history/statistics',
//         recent: 'GET /api/history/recent',
//         details: 'GET /api/history/:id',
//         download: 'GET /api/history/:id/download'
//       }
//     }
//   });
// });

// Mount route modules
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/payments", paymentRoutes);
router.use("/support", supportRoutes);
router.use("/virtual-accounts", virtualAccountRoutes);
router.use("/transactions", transactionRoutes);
router.use("/notifications", notificationRoutes);

// 404 handler for API routes
router.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
    statusCode: 404,
    // availableRoutes: {
    //   health: 'GET /api/health',
    //   docs: 'GET /api/docs',
    //   auth: '/api/auth/*',
    //   users: '/api/users/*',
    //   tasks: '/api/admin/tasks/*',
    //   configurations: '/api/admin/config/*',
    //   lookups: '/api/lookup/*',
    //   history: '/api/history/*'
    // }
  });
});

// Global error handler for API routes
router.use((error, req, res, next) => {
  console.error("API Error:", {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    timestamp: new Date().toISOString(),
  });

  // Handle specific error types
  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: "Validation error",
      details: error.message,
      statusCode: 400,
    });
  }

  if (error.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: "Invalid ID format",
      statusCode: 400,
    });
  }

  if (error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "Duplicate entry",
      statusCode: 409,
    });
  }

  // Default error response
  const statusCode = error.statusCode || error.status || 500;
  const message = error.message || "Something went wrong";

  res.status(statusCode).json({
    success: false,
    message:
      process.env.NODE_ENV === "production" ? "Something went wrong" : message,
    statusCode,
    ...(process.env.NODE_ENV !== "production" && { stack: error.stack }),
  });
});

module.exports = router;
