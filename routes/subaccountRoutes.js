const express = require('express');
const router = express.Router();
const { 
  createSubaccount,
  getSubaccounts,
  deleteSubaccount
} = require('../controllers/subaccountController');
const { authenticateToken, isClient } = require('../middleware/auth');

router.post('/', authenticateToken, isClient, createSubaccount);
router.get('/', authenticateToken, isClient, getSubaccounts);
router.delete('/:id', authenticateToken, isClient, deleteSubaccount);

module.exports = router;
