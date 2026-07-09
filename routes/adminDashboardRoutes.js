// routes/adminDashboardRoutes.js
const express = require('express');
const router = express.Router();

// Import controllers
const adminDashboardController = require('../controllers/adminDashboardController');

// Import middleware
const { 
  authenticateToken, 
  isAdmin,
  createRateLimit 
} = require('../middleware/auth');

// Rate limiting for admin endpoints
const adminRateLimit = createRateLimit(60 * 1000, 100, 'Too many admin requests, please try again later');

// Apply authentication and admin role check to all routes
router.use(authenticateToken);
router.use(isAdmin);
router.use(adminRateLimit);

// ================================
// DASHBOARD OVERVIEW
// ================================

// Get main dashboard overview with key metrics
router.get('/overview', adminDashboardController.getDashboardOverview);

// ================================
// FINANCIAL ANALYTICS
// ================================

// Get revenue analytics with time-based filtering
// Query params: period (7days, 30days, 12months)
router.get('/analytics/revenue', adminDashboardController.getRevenueAnalytics);

// ================================
// USER ANALYTICS
// ================================

// Get user analytics and statistics
router.get('/analytics/users', adminDashboardController.getUserAnalytics);

// ================================
// TASK ANALYTICS
// ================================

// Get task usage and performance analytics
router.get('/analytics/tasks', adminDashboardController.getTaskAnalytics);

// ================================
// SYSTEM MONITORING
// ================================

// Get system status and health metrics
router.get('/system/status', adminDashboardController.getSystemStatus);

// ================================
// ACTIVITY MONITORING
// ================================

// Get recent activity feed
// Query params: limit (default: 20)
router.get('/activity/recent', adminDashboardController.getRecentActivity);

module.exports = router;