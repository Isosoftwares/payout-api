// routes/userRoutes.js
const express = require('express');
const router = express.Router();

// Import controllers
const userController = require('../controllers/userController');

// Import middleware
const { 
  authenticateToken, 
  isAdmin, 
  isClient, 
  isAuthenticated
} = require('../middleware/auth');

// ================================
// ADMIN USER MANAGEMENT ROUTES
// ================================
router.get('/', authenticateToken, isAdmin, userController.getAllUsers);
router.get('/admin/users/statistics', authenticateToken, isAdmin, userController.getUserStatistics);
router.get('/:id', authenticateToken, isAdmin, userController.getUserById);
router.post('/admin/users', authenticateToken, isAdmin, userController.createUser);
router.patch('/:id', authenticateToken, isAdmin, userController.updateUser);
router.delete('/:id', authenticateToken, isAdmin, userController.deleteUser);
router.delete('/admin/users/:id', authenticateToken, isAdmin, userController.deleteUser);
router.post('/:id/reset-password', authenticateToken, isAdmin, userController.resetUserPassword);
router.post('/:id/toggle-suspend', authenticateToken, isAdmin, userController.toggleSuspendUser);
router.post('/:id/add-balance', authenticateToken, isAdmin, userController.addBalance);

// Admin managing client payment methods
router.post('/:id/payment-methods', authenticateToken, isAdmin, userController.addClientPaymentMethod);
router.put('/:id/payment-methods/:methodId', authenticateToken, isAdmin, userController.editClientPaymentMethod);
router.delete('/:id/payment-methods/:methodId', authenticateToken, isAdmin, userController.deleteClientPaymentMethod);
router.patch('/:id/payment-methods/:methodId/default', authenticateToken, isAdmin, userController.setDefaultClientPaymentMethod);

// ================================
// USER PROFILE ROUTES (AUTHENTICATED)
// ================================
router.get('/profile/own', authenticateToken, isAuthenticated, userController.getOwnProfile);
router.patch('/update-own/profile', authenticateToken, isAuthenticated, userController.updateOwnProfile);
router.get('/profile/telegram/bot-info', authenticateToken, isAuthenticated, userController.getTelegramBotInfo);
router.post('/profile/telegram/test', authenticateToken, isAuthenticated, userController.testTelegramNotification);
router.post('/payment-methods', authenticateToken, isAuthenticated, userController.addPaymentMethod);
router.delete('/payment-methods/:methodId', authenticateToken, isAuthenticated, userController.deletePaymentMethod);
router.put('/payment-methods/:methodId', authenticateToken, isAuthenticated, userController.editPaymentMethod);
router.patch('/payment-methods/:methodId/default', authenticateToken, isAuthenticated, userController.setDefaultPaymentMethod);

// ================================
// CLIENT BALANCE ROUTES
// ================================
router.get('/balance', authenticateToken, isClient, userController.getOwnBalance);
router.get('/dashboard/stats', authenticateToken, isClient, userController.getClientDashboardStats);

module.exports = router;