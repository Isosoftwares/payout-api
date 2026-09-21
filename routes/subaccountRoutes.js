const express = require('express');
const router = express.Router();
const { 
  createSubaccount,
  getSubaccounts,
  deleteSubaccount
} = require('../controllers/subaccountController');
const { authenticateToken, isAuthenticated } = require('../middleware/auth');

router.post('/', authenticateToken, isAuthenticated, createSubaccount);
router.get('/', authenticateToken, isAuthenticated, getSubaccounts);
router.delete('/:id', authenticateToken, isAuthenticated, deleteSubaccount);

module.exports = router;
