const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { authenticateToken, isAdmin } = require("../middleware/auth");
const { 
  uploadPayments, 
  getMaturitySettings, 
  updateMaturitySettings,
  getUploadHistories,
  downloadUploadReport
} = require("../controllers/paymentController");

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `payments-${Date.now()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) {
      return cb(new Error("Only CSV, XLSX, and XLS files are allowed"));
    }
    cb(null, true);
  },
});

router.post("/upload", authenticateToken, isAdmin, upload.single("file"), uploadPayments);
router.get("/maturity-settings", authenticateToken, isAdmin, getMaturitySettings);
router.put("/maturity-settings", authenticateToken, isAdmin, updateMaturitySettings);
router.get("/upload-histories", authenticateToken, isAdmin, getUploadHistories);
router.get("/upload-histories/:id/download", authenticateToken, isAdmin, downloadUploadReport);

module.exports = router;
