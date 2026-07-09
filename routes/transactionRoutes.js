const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { authenticateToken, isAdmin, isAuthenticated } = require('../middleware/auth');

router.post('/deposit', authenticateToken, isAdmin, transactionController.recordDeposit);
router.get('/payout-requests', authenticateToken, isAuthenticated, transactionController.getPayoutRequests);
router.post('/payout-requests', authenticateToken, isAuthenticated, transactionController.createPayoutRequest);
router.put('/payout-requests/:id', authenticateToken, isAdmin, transactionController.updatePayoutRequest);
router.post('/payout', authenticateToken, isAdmin, transactionController.recordPayout);
router.get('/fee-ledger', authenticateToken, isAdmin, transactionController.getFeeLedger);
router.get('/', authenticateToken, isAuthenticated, transactionController.getTransactions);

module.exports = router;
