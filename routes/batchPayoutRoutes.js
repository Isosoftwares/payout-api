const express = require('express');
const router = express.Router();
const { 
  getAdmins, 
  getClientsByAdmin, 
  getClientMaturedNames, 
  getAdminMaturedStats,
  executeBatchPayout,
  getAllTransactions
} = require('../controllers/batchPayoutController');
const { authenticateToken, isAdmin } = require('../middleware/auth');

router.get('/admins', authenticateToken, isAdmin, getAdmins);
router.get('/clients/:adminId', authenticateToken, isAdmin, getClientsByAdmin);
router.get('/matured-names/:clientId', authenticateToken, isAdmin, getClientMaturedNames);
router.get('/matured-stats/:adminId', authenticateToken, isAdmin, getAdminMaturedStats);
router.post('/execute', authenticateToken, isAdmin, executeBatchPayout);
router.get('/transactions', authenticateToken, isAdmin, getAllTransactions);

module.exports = router;
