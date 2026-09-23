const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { 
  uploadPayoutNames, 
  uploadBacklogNames,
  getPayoutNames,
  createAllocationRequest,
  getClientAllocationRequests,
  getAllAllocationRequests,
  updateAllocationRequest,
  assignNamesToClient,
  unassignNamesFromClient,
  getMyInventory,
  claimPayoutNames,
  getSubaccountInventory,
  deletePayoutName,
  createSpecificNameRequest,
  getClientSpecificNameRequests,
  getAllSpecificNameRequests,
  approveSpecificNameRequest,
  rejectSpecificNameRequest,
  adminCreateSpecificPayoutName,
  getPayoutNameLogs,
  addPayoutNameLogNarration,
  getSelfAllocationQuota,
} = require("../controllers/payoutNameController");
const { authenticateToken, isAdmin, isClient, isAuthenticated } = require("../middleware/auth");
const fs = require("fs");

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
    cb(null, `payout-names-${Date.now()}${path.extname(file.originalname)}`);
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

// Admin Routes
router.post("/upload", authenticateToken, isAdmin, upload.single("file"), uploadPayoutNames);
router.post("/admin/upload-backlog", authenticateToken, isAdmin, upload.single("file"), uploadBacklogNames);
router.get("/", authenticateToken, isAdmin, getPayoutNames);
router.post("/assign", authenticateToken, isAdmin, assignNamesToClient);
router.post("/unassign", authenticateToken, isAdmin, unassignNamesFromClient);
router.post("/admin/create-specific", authenticateToken, isAdmin, adminCreateSpecificPayoutName);
router.get("/requests", authenticateToken, isAdmin, getAllAllocationRequests);
router.put("/requests/:id", authenticateToken, isAdmin, updateAllocationRequest);
router.get("/specific-requests", authenticateToken, isAdmin, getAllSpecificNameRequests);
router.put("/specific-requests/:id/approve", authenticateToken, isAdmin, approveSpecificNameRequest);
router.put("/specific-requests/:id/reject", authenticateToken, isAdmin, rejectSpecificNameRequest);
router.delete("/:id", authenticateToken, isAdmin, deletePayoutName);

// Activity Logs & Narration (Admin and owner Client)
router.get("/:id/logs", authenticateToken, isAuthenticated, getPayoutNameLogs);
router.post("/:id/logs/narration", authenticateToken, isAuthenticated, addPayoutNameLogNarration);

// Client Routes
router.get("/self-allocation-quota", authenticateToken, isClient, getSelfAllocationQuota);
router.post("/request", authenticateToken, isClient, createAllocationRequest);
router.get("/requests/me", authenticateToken, isClient, getClientAllocationRequests);
router.post("/specific-request", authenticateToken, isClient, createSpecificNameRequest);
router.get("/specific-requests/me", authenticateToken, isClient, getClientSpecificNameRequests);
router.get("/my-inventory", authenticateToken, isClient, getMyInventory);
router.post("/claim", authenticateToken, isAuthenticated, claimPayoutNames);

// Subaccount Routes
router.get("/subaccount-inventory", authenticateToken, getSubaccountInventory);

module.exports = router;
