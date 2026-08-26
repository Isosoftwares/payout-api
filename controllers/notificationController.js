const Notification = require('../models/Notification');

const formatResponse = (success, data, message = null, statusCode = 200) => ({
  success, data, message, statusCode
});

const getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50);
    
    const unreadCount = await Notification.countDocuments({ recipient: req.user.id, isRead: false });
    
    res.status(200).json(formatResponse(true, { notifications, unreadCount }, 'Notifications fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const markAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user.id, isRead: false },
      { $set: { isRead: true } }
    );
    res.status(200).json(formatResponse(true, null, 'Notifications marked as read'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

const getAdminPendingCount = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json(formatResponse(false, null, 'Forbidden', 403));
    }
    const PayoutName = require('../models/PayoutName');
    
    const maturedCount = await PayoutName.countDocuments({ paymentStatus: 'matured' });
    
    res.status(200).json(formatResponse(true, {
      maturedCount,
      totalPending: maturedCount
    }, 'Admin pending counts fetched successfully'));
  } catch (error) {
    res.status(500).json(formatResponse(false, null, error.message, 500));
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  getAdminPendingCount
};
