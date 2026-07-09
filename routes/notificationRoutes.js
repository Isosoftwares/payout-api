const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);
router.get('/', notificationController.getNotifications);
router.put('/read', notificationController.markAsRead);
router.get('/admin-pending', notificationController.getAdminPendingCount);

module.exports = router;
