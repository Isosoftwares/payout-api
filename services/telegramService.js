const axios = require("axios");
const https = require("https");
const User = require("../models/User");

// Persistent HTTPS agent to keep sockets warm and prevent TLS renegotiation latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  timeout: 40000,
});

class TelegramService {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.botUsername = process.env.TELEGRAM_BOT_USERNAME;
    this.apiUrl = this.token ? `https://api.telegram.org/bot${this.token}` : null;
    this.isPolling = false;
    this.pollingOffset = 0;
  }

  /**
   * Reload credentials (e.g. if updated at runtime)
   */
  reloadConfig() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.botUsername = process.env.TELEGRAM_BOT_USERNAME;
    this.apiUrl = this.token ? `https://api.telegram.org/bot${this.token}` : null;
  }

  /**
   * Initialize service and start update listener
   */
  async init() {
    this.reloadConfig();

    if (!this.token) {
      console.log("[TelegramService] TELEGRAM_BOT_TOKEN is not set in .env. Telegram notifications are disabled.");
      return;
    }

    try {
      const response = await axios.get(`${this.apiUrl}/getMe`, { 
        timeout: 20000,
        httpsAgent 
      });
      if (response.data && response.data.ok) {
        const bot = response.data.result;
        this.botUsername = bot.username;
        console.log(`[TelegramService] Connected to Telegram Bot @${bot.username} (${bot.first_name})`);
        
        // Start long polling for /start linking
        this.startPolling();
      } else {
        console.warn("[TelegramService] Failed to verify bot token with Telegram:", response.data);
      }
    } catch (error) {
      console.error("[TelegramService] Error verifying bot token:", error?.response?.data || error.message);
    }
  }

  /**
   * Long-polling loop to capture /start events and link users
   */
  async startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    const poll = async () => {
      if (!this.isPolling) return;

      try {
        const res = await axios.get(`${this.apiUrl}/getUpdates`, {
          params: {
            offset: this.pollingOffset,
            timeout: 25,
            allowed_updates: ["message"],
          },
          timeout: 40000,
          httpsAgent,
        });

        if (res.data && res.data.ok && Array.isArray(res.data.result)) {
          for (const update of res.data.result) {
            this.pollingOffset = update.update_id + 1;
            if (update.message) {
              await this.handleIncomingMessage(update.message);
            }
          }
        }
      } catch (err) {
        // Sleep on error to avoid tight error loop
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (this.isPolling) {
        setImmediate(poll);
      }
    };

    poll();
  }

  /**
   * Stop polling (useful for tests or graceful shutdown)
   */
  stopPolling() {
    this.isPolling = false;
  }

  /**
   * Handle incoming messages (e.g. /start or /start <userId>)
   */
  async handleIncomingMessage(message) {
    try {
      const text = (message.text || "").trim();
      const chatId = message.chat.id.toString();
      const telegramUsername = (message.from?.username || "").toLowerCase();
      const senderName = message.from?.first_name || "there";

      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const startPayload = parts[1]?.trim(); // e.g. userId

        let linkedUser = null;

        // 1. Try linking by payload (User ID)
        if (startPayload && startPayload.match(/^[0-9a-fA-F]{24}$/)) {
          linkedUser = await User.findById(startPayload);
        }

        // 2. If not found by payload, try linking by username
        if (!linkedUser && telegramUsername) {
          linkedUser = await User.findOne({
            telegramUsername: new RegExp(`^@?${telegramUsername}$`, "i"),
          });
        }

        if (linkedUser) {
          linkedUser.telegramChatId = chatId;
          if (!linkedUser.telegramUsername && telegramUsername) {
            linkedUser.telegramUsername = telegramUsername;
          }
          await linkedUser.save();

          const userName = linkedUser.profile?.firstName
            ? `${linkedUser.profile.firstName} ${linkedUser.profile.lastName || ""}`.trim()
            : linkedUser.email;

          await this.sendToChat(
            chatId,
            `<b>✅ Telegram Connected Successfully!</b>\n\n` +
            `Hello <b>${userName}</b>, your Telegram account has been linked to your <b>Payout System</b> dashboard.\n\n` +
            `🔔 You will now receive real-time notifications for payment receipts, payout approvals, requests, and important system events.\n\n` +
            `<i>Role: ${linkedUser.role.toUpperCase()}</i>`
          );
          return;
        }

        // If no user could be matched
        await this.sendToChat(
          chatId,
          `<b>👋 Welcome to Payout System Bot!</b>\n\n` +
          `Hello ${senderName}! To link this Telegram account with your Payout System account:\n\n` +
          `1. Go to your dashboard <b>Profile</b> page.\n` +
          `2. Enter your Telegram username (<code>@${telegramUsername || "your_username"}</code>).\n` +
          `3. Click the <b>Connect on Telegram</b> button in your profile.\n\n` +
          `<i>Your Telegram Chat ID: <code>${chatId}</code></i>`
        );
      } else if (text === "/status") {
        const user = await User.findOne({ telegramChatId: chatId });
        if (user) {
          await this.sendToChat(
            chatId,
            `<b>ℹ️ Status: Connected</b>\n\n` +
            `Linked Account: <b>${user.email}</b> (${user.role})\n` +
            `Telegram Username: @${user.telegramUsername || "N/A"}\n` +
            `Notifications: ${user.telegramNotificationsEnabled !== false ? "Enabled ✅" : "Disabled ❌"}`
          );
        } else {
          await this.sendToChat(
            chatId,
            `<b>ℹ️ Status: Not Linked</b>\n\nPlease connect your account from the dashboard Profile page.`
          );
        }
      }
    } catch (error) {
      console.error("[TelegramService] Error handling incoming message:", error);
    }
  }

  /**
   * Send a raw message to a specific Telegram Chat ID with retry and 35s timeout
   */
  async sendToChat(chatId, text, options = {}, maxAttempts = 2) {
    this.reloadConfig();
    if (!this.apiUrl || !chatId) return { success: false, reason: "No API URL or Chat ID" };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.post(
          `${this.apiUrl}/sendMessage`,
          {
            chat_id: chatId,
            text,
            parse_mode: options.parseMode || "HTML",
            disable_web_page_preview: true,
          },
          { 
            timeout: 35000,
            httpsAgent,
          }
        );

        return { success: true, data: response.data };
      } catch (error) {
        const isTimeout = error.code === "ECONNABORTED" || (error.message && error.message.includes("timeout"));
        const isNetworkErr = error.code === "ENOTFOUND" || error.code === "ECONNRESET" || error.code === "ETIMEDOUT";

        if (attempt < maxAttempts && (isTimeout || isNetworkErr)) {
          console.warn(`[TelegramService] Warning: Attempt ${attempt} sending to chat ${chatId} timed out or hit network glitch. Retrying in 1.5s...`);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }

        const errDetail = error?.response?.data || error.message;
        console.error(`[TelegramService] Error sending to chat ${chatId}:`, errDetail);
        return { success: false, error: errDetail };
      }
    }
  }

  /**
   * Send notification to a specific user by userId
   */
  async sendToUser(userId, message, options = {}) {
    if (!userId) return;

    try {
      const user = await User.findById(userId).select("telegramChatId telegramUsername telegramNotificationsEnabled");
      if (!user) return;

      if (!user.telegramChatId) {
        // User hasn't connected or started the bot yet
        return;
      }

      if (user.telegramNotificationsEnabled === false) {
        // User has opted out of Telegram notifications
        return;
      }

      return await this.sendToChat(user.telegramChatId, message, options);
    } catch (error) {
      console.error(`[TelegramService] Failed to send to user ${userId}:`, error.message);
    }
  }

  /**
   * Send notification to ALL active administrators who have Telegram connected
   */
  async sendToAdmins(message, options = {}) {
    try {
      const admins = await User.find({
        role: "admin",
        isActive: true,
        isSuspended: { $ne: true },
        telegramChatId: { $ne: null, $exists: true },
        telegramNotificationsEnabled: { $ne: false },
      }).select("email telegramChatId");

      if (!admins || admins.length === 0) {
        return;
      }

      const promises = admins.map((admin) =>
        this.sendToChat(admin.telegramChatId, message, options)
      );

      return await Promise.allSettled(promises);
    } catch (error) {
      console.error("[TelegramService] Failed to broadcast to admins:", error.message);
    }
  }

  /**
   * Send a test message to verify a user's Telegram connection
   */
  async sendTestMessage(userId) {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (!user.telegramChatId) {
      throw new Error(
        "Telegram is not connected yet. Please click 'Connect on Telegram' and press Start in Telegram first."
      );
    }

    const userName = user.profile?.firstName
      ? `${user.profile.firstName} ${user.profile.lastName || ""}`.trim()
      : user.email;

    const testText =
      `<b>🔔 Payout System Test Notification</b>\n\n` +
      `Hello <b>${userName}</b>! 👋\n\n` +
      `This is a test notification confirming that your Telegram account is successfully connected to <b>Payout System</b>.\n\n` +
      `✨ You are all set to receive real-time notifications!`;

    const result = await this.sendToChat(user.telegramChatId, testText);
    if (!result.success) {
      throw new Error(
        typeof result.error === "object"
          ? result.error.description || "Failed to send message via Telegram"
          : result.error
      );
    }
    return result;
  }

  /**
   * Helper to format clean HTML notification message
   */
  formatNotification({ icon = "🔔", title, message, details = [] }) {
    let text = `<b>${icon} ${title}</b>\n\n${message}`;

    if (details && details.length > 0) {
      text += "\n\n<b>Details:</b>";
      for (const item of details) {
        if (item && item.label && item.value !== undefined && item.value !== null) {
          text += `\n• <b>${item.label}:</b> <code>${item.value}</code>`;
        }
      }
    }

    text += `\n\n<i>Payout System • ${new Date().toLocaleTimeString()}</i>`;
    return text;
  }
}

// Export singleton instance
const telegramService = new TelegramService();
module.exports = telegramService;
