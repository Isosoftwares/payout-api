const express = require("express");
const supportController = require("../controllers/SupportController");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");

router.use(authenticateToken);

router
  .post("/", supportController.sendUsMessage)
  .post("/admin", supportController.adminSendMessage)
  .get("/", supportController.getSupportMessages)
  .get("/admin-unread", supportController.countAdminUnread)
  .get("/messages/:role/:userId", supportController.getMyMessages)
  .get("/customer-unread/:userId", supportController.countCustomerUnread)
  .patch("/delete/message", supportController.deleteMessageById);

module.exports = router;
