const express = require("express");
const router = express.Router();
const { getDailyReport } = require("../controllers/reportController");
const { authenticateToken, isAuthenticated } = require("../middleware/auth");

router.get("/daily", authenticateToken, isAuthenticated, getDailyReport);

module.exports = router;
