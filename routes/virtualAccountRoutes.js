const express = require('express');
const router = express.Router();
const virtualAccountController = require('../controllers/virtualAccountController');
const { authenticateToken, isAdmin, isAuthenticated } = require('../middleware/auth');

router.post('/', authenticateToken, isAuthenticated, virtualAccountController.createVirtualAccount);
router.get('/', authenticateToken, isAuthenticated, virtualAccountController.getVirtualAccounts);
router.put('/:id/bank-details', authenticateToken, isAdmin, virtualAccountController.updateBankDetails);

module.exports = router;
