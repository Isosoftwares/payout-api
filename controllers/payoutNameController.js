const PayoutName = require("../models/PayoutName");
const User = require("../models/User");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const telegramService = require("../services/telegramService");

// @desc    Upload Payout Names via CSV or Excel (optionally allocated to a specific client)
// @route   POST /api/payout-names/upload
// @access  Private/Admin
const uploadPayoutNames = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a CSV or Excel file." });
    }

    const { allocateToClientId } = req.body;
    let targetClient = null;

    if (allocateToClientId) {
      targetClient = await User.findById(allocateToClientId);
      if (!targetClient) {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(404).json({ message: "Selected client to allocate to was not found." });
      }
    }

    // Read and parse using XLSX (supports .csv, .xlsx, .xls)
    let results = [];
    try {
      const workbook = XLSX.readFile(req.file.path, { cellDates: true, raw: false });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      results = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
    } catch (parseErr) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ message: "Failed to parse file. Please ensure it is a valid CSV or Excel file.", error: parseErr.message });
    }

    const errors = [];
    let duplicates = 0;
    let added = 0;

    for (const row of results) {
      const keys = Object.keys(row);
      let name = null;
      let routingNumber = null;
      let accountNumber = null;
      let rowClientEmail = null;

      for (const key of keys) {
        const lowerKey = key.trim().toLowerCase();
        if (lowerKey === "name") name = String(row[key]).trim();
        else if (lowerKey === "routing number" || lowerKey === "routingnumber") routingNumber = String(row[key]).trim();
        else if (lowerKey === "account number" || lowerKey === "accountnumber") accountNumber = String(row[key]).trim();
        else if (lowerKey === "client" || lowerKey === "client email" || lowerKey === "clientemail" || lowerKey === "email") rowClientEmail = String(row[key]).trim();
      }

      if (!name || !routingNumber || !accountNumber) {
        errors.push(`Row missing required fields (name, routingNumber, accountNumber): ${JSON.stringify(row)}`);
        continue;
      }

      const nameLower = name.toLowerCase();

      try {
        // Check for existing
        const existing = await PayoutName.findOne({ 
          $or: [
            { nameLower },
            { accountNumber }
          ]
        });
        if (existing) {
          duplicates++;
          errors.push(`Duplicate name or account number found in database: '${name}' / '${accountNumber}'`);
          continue;
        }

        // Determine status and allocatedTo
        let status = 'available';
        let allocatedTo = null;

        if (targetClient) {
          status = 'allocated';
          allocatedTo = targetClient._id;
        } else if (rowClientEmail) {
          const matchedClient = await User.findOne({ email: rowClientEmail.toLowerCase(), role: 'client' });
          if (matchedClient) {
            status = 'allocated';
            allocatedTo = matchedClient._id;
          }
        }

        // Create new
        await PayoutName.create({
          name,
          nameLower,
          routingNumber,
          accountNumber,
          status,
          allocatedTo,
        });
        added++;
      } catch (dbErr) {
        if (dbErr.code === 11000) {
          duplicates++;
          errors.push(`Duplicate name found: '${name}'`);
        } else {
          errors.push(`Error saving '${name}': ${dbErr.message}`);
        }
      }
    }

    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    const clientLabel = targetClient 
      ? (targetClient.profile?.firstName ? `${targetClient.profile.firstName} ${targetClient.profile.lastName || ''} (${targetClient.email})` : targetClient.email)
      : null;

    res.status(200).json({
      message: targetClient 
        ? `Upload completed. ${added} names uploaded and pre-allocated to ${clientLabel}.`
        : `Upload completed. ${added} names added to the available pool.`,
      report: {
        totalProcessed: results.length,
        added,
        duplicates,
        allocatedTo: clientLabel,
        errors,
      },
    });

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: "Server error during file upload", error: error.message });
  }
};

// @desc    Get all Payout Names
// @route   GET /api/payout-names
// @access  Private/Admin
const getPayoutNames = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const status = req.query.status || 'all';
    const allocatedTo = req.query.allocatedTo;

    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { accountNumber: { $regex: search, $options: 'i' } },
        { routingNumber: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status !== 'all') {
      query.status = status;
    }

    if (allocatedTo) {
      query.allocatedTo = allocatedTo;
    }

    if (req.query.subaccount) {
      if (req.query.subaccount === 'self') {
        query.claimedForSubaccount = null;
      } else {
        query.claimedForSubaccount = req.query.subaccount;
      }
    }

    const total = await PayoutName.countDocuments(query);
    const payoutNames = await PayoutName.find(query)
      .populate('allocatedTo', 'email profile')
      .populate('claimedForSubaccount', 'username')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      data: payoutNames,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const AllocationRequest = require("../models/AllocationRequest");

// @desc    Client requests allocation of names
// @route   POST /api/payout-names/request
// @access  Private/Client
const createAllocationRequest = async (req, res) => {
  try {
    const { requestedCount } = req.body;
    if (!requestedCount || requestedCount < 1) {
      return res.status(400).json({ message: "Please provide a valid requestedCount" });
    }
    const newRequest = await AllocationRequest.create({
      client: req.user.id,
      requestedCount
    });

    // Broadcast to all admins on Telegram
    User.findById(req.user.id).select('email profile').then(clientUser => {
      const clientName = clientUser?.profile?.firstName 
        ? `${clientUser.profile.firstName} ${clientUser.profile.lastName || ''}`.trim() 
        : (clientUser?.email || 'A client');

      const adminTeleMsg = telegramService.formatNotification({
        icon: "📋",
        title: "New Allocation Request",
        message: `Client <b>${clientName}</b> requested allocation of <b>${requestedCount}</b> payout name(s).`,
        details: [
          { label: "Client", value: `${clientName} (${clientUser?.email || ''})` },
          { label: "Quantity", value: requestedCount }
        ]
      });
      telegramService.sendToAdmins(adminTeleMsg).catch(() => {});
    }).catch(() => {});

    res.status(201).json({ message: "Request submitted successfully", data: newRequest });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Get client's own allocation requests
// @route   GET /api/payout-names/requests/me
// @access  Private/Client
const getClientAllocationRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const filter = { client: req.user.id };

    const total = await AllocationRequest.countDocuments(filter);
    const requests = await AllocationRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      data: requests,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Get all allocation requests (Admin)
// @route   GET /api/payout-names/requests
// @access  Private/Admin
const getAllAllocationRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status || 'all';
    
    const filter = {};
    if (status !== 'all') {
      filter.status = status;
    }

    const total = await AllocationRequest.countDocuments(filter);
    const requests = await AllocationRequest.find(filter)
      .populate('client', 'profile email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      data: requests,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin approves/rejects allocation request
// @route   PUT /api/payout-names/requests/:id
// @access  Private/Admin
const updateAllocationRequest = async (req, res) => {
  try {
    const { status, allocatedCount } = req.body;
    const request = await AllocationRequest.findById(req.params.id);
    
    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }
    
    request.status = status;
    if (status === 'approved' && allocatedCount) {
      if (request.allocatedCount > 0) {
        return res.status(400).json({ message: "This request has already been allocated." });
      }
      
      const availableCount = await PayoutName.countDocuments({ status: 'available' });
      if (availableCount < allocatedCount) {
        return res.status(400).json({ message: `Not enough available payout names. Only ${availableCount} available.` });
      }
      
      const namesToAllocate = await PayoutName.find({ status: 'available' }).limit(allocatedCount);
      const nameIds = namesToAllocate.map(n => n._id);
      
      await PayoutName.updateMany(
        { _id: { $in: nameIds } },
        { $set: { status: 'allocated', allocatedTo: request.client } }
      );
      
      request.allocatedCount = allocatedCount;
    }
    
    await request.save();

    // Notify client if approved or rejected
    if (status === 'approved' || status === 'rejected') {
      const clientTeleMsg = telegramService.formatNotification({
        icon: status === 'approved' ? "✅" : "❌",
        title: `Allocation Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
        message: status === 'approved'
          ? `Your request for payout names was <b>approved</b>. <b>${allocatedCount}</b> name(s) have been allocated to your account!`
          : `Your request for payout names was <b>rejected</b>.`,
        details: [
          { label: "Status", value: status.toUpperCase() },
          ...(status === 'approved' ? [{ label: "Names Allocated", value: allocatedCount }] : [])
        ]
      });
      telegramService.sendToUser(request.client, clientTeleMsg).catch(() => {});
    }

    res.status(200).json({ message: "Request updated successfully", data: request });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin manually assigns names to a client
// @route   POST /api/payout-names/assign
// @access  Private/Admin
const assignNamesToClient = async (req, res) => {
  try {
    const { clientId, count } = req.body;
    
    if (!clientId || !count || count < 1) {
      return res.status(400).json({ message: "Please provide a valid client ID and count" });
    }
    
    const availableCount = await PayoutName.countDocuments({ status: 'available' });
    if (availableCount < count) {
      return res.status(400).json({ message: `Not enough available payout names. Only ${availableCount} available.` });
    }
    
    const namesToAllocate = await PayoutName.find({ status: 'available' }).limit(count);
    const nameIds = namesToAllocate.map(n => n._id);
    
    await PayoutName.updateMany(
      { _id: { $in: nameIds } },
      { $set: { status: 'allocated', allocatedTo: clientId } }
    );
    
    // Create an automatically approved allocation request for the client
    const newRequest = await AllocationRequest.create({
      client: clientId,
      requestedCount: count,
      allocatedCount: count,
      status: 'approved'
    });
    
    res.status(201).json({ message: "Names assigned successfully", data: newRequest });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin manually unassigns names from a client
// @route   POST /api/payout-names/unassign
// @access  Private/Admin
const unassignNamesFromClient = async (req, res) => {
  try {
    const { clientId, count } = req.body;
    
    if (!clientId || !count || count < 1) {
      return res.status(400).json({ message: "Please provide a valid client ID and count" });
    }
    
    const allocatedCount = await PayoutName.countDocuments({ status: 'allocated', allocatedTo: clientId });
    if (allocatedCount < count) {
      return res.status(400).json({ message: `Client only has ${allocatedCount} un-claimed names allocated.` });
    }
    
    const namesToUnallocate = await PayoutName.find({ status: 'allocated', allocatedTo: clientId }).limit(count);
    const nameIds = namesToUnallocate.map(n => n._id);
    
    await PayoutName.updateMany(
      { _id: { $in: nameIds } },
      { $set: { status: 'available', allocatedTo: null } }
    );
    
    res.status(200).json({ message: `Successfully unallocated ${count} names from the client` });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ==========================================
// CLIENT ACTIONS
// ==========================================

// Get my inventory (allocated count and claimed list)
const getMyInventory = async (req, res) => {
  try {
    const clientId = req.user.id;

    const allocatedCount = await PayoutName.countDocuments({
      status: 'allocated',
      allocatedTo: clientId
    });

    const { search, subaccount } = req.query;
    
    let filter = {
      status: 'claimed',
      allocatedTo: clientId
    };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { accountNumber: { $regex: search, $options: 'i' } }
      ];
    }

    if (subaccount) {
      if (subaccount === 'self') {
        filter.claimedForSubaccount = null;
      } else {
        filter.claimedForSubaccount = subaccount;
      }
    }

    const claimedNames = await PayoutName.find(filter)
      .populate('claimedForSubaccount', 'username')
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        allocatedCount,
        claimedNames
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Claim allocated names (or Admin direct claim)
const claimPayoutNames = async (req, res) => {
  try {
    let clientId = req.user.id;
    const isAdminUser = req.user.role === 'admin';
    if (isAdminUser && req.body.clientId) {
      clientId = req.body.clientId;
    }

    const { count, subaccountId } = req.body;
    
    if (!count || count <= 0) {
      return res.status(400).json({ message: 'Invalid count provided' });
    }

    // Verify subaccount if provided
    let claimedForSubaccount = null;
    let subaccountDoc = null;
    if (subaccountId && subaccountId !== 'self') {
      const Subaccount = require('../models/Subaccount');
      subaccountDoc = await Subaccount.findOne({ _id: subaccountId, clientId });
      if (!subaccountDoc) {
        return res.status(404).json({ message: 'Subaccount not found or does not belong to the client' });
      }
      claimedForSubaccount = subaccountDoc._id;
    }

    // If regular client user (not admin):
    if (!isAdminUser) {
      const allocatedNames = await PayoutName.find({
        status: 'allocated',
        allocatedTo: clientId
      }).limit(count);

      if (allocatedNames.length < count) {
        return res.status(400).json({ message: `You only have ${allocatedNames.length} names available to claim` });
      }

      const idsToClaim = allocatedNames.map(name => name._id);

      await PayoutName.updateMany(
        { _id: { $in: idsToClaim } },
        { $set: { status: 'claimed', claimedForSubaccount, updatedAt: Date.now() } }
      );

      return res.status(200).json({ success: true, claimedCount: count, message: `Successfully claimed ${count} payout names` });
    }

    // IF ADMIN USER: Direct Claim Logic
    // 1. Claim any existing allocated names for this client first
    const allocatedNames = await PayoutName.find({
      status: 'allocated',
      allocatedTo: clientId
    }).limit(count);

    const allocatedIds = allocatedNames.map(n => n._id);
    const allocatedUsedCount = allocatedIds.length;
    const remainingNeeded = count - allocatedUsedCount;

    let poolIds = [];
    if (remainingNeeded > 0) {
      const availablePoolNames = await PayoutName.find({ status: 'available' }).limit(remainingNeeded);
      if (availablePoolNames.length < remainingNeeded) {
        return res.status(400).json({
          message: `Cannot claim ${count} names. Client has ${allocatedUsedCount} allocated, and only ${availablePoolNames.length} available in the general pool.`
        });
      }
      poolIds = availablePoolNames.map(n => n._id);
    }

    // Update allocated names to claimed
    if (allocatedIds.length > 0) {
      await PayoutName.updateMany(
        { _id: { $in: allocatedIds } },
        { $set: { status: 'claimed', claimedForSubaccount, updatedAt: Date.now() } }
      );
    }

    // Update pool names to claimed & allocatedTo clientId
    if (poolIds.length > 0) {
      await PayoutName.updateMany(
        { _id: { $in: poolIds } },
        { $set: { status: 'claimed', allocatedTo: clientId, claimedForSubaccount, updatedAt: Date.now() } }
      );
    }

    // Send Telegram notification to client if connected
    const clientUser = await User.findById(clientId).select('email profile');
    const clientName = clientUser?.profile?.firstName 
      ? `${clientUser.profile.firstName} ${clientUser.profile.lastName || ''}`.trim() 
      : (clientUser?.email || 'Client');

    const targetLabel = subaccountDoc ? subaccountDoc.username : "Main Account (Self)";

    const clientTeleMsg = telegramService.formatNotification({
      icon: "⚡",
      title: "Payout Names Claimed",
      message: `<b>${count}</b> payout name(s) have been directly claimed for your account (Target: <b>${targetLabel}</b>).`,
      details: [
        { label: "Quantity", value: count },
        { label: "Assigned To", value: targetLabel },
        { label: "Claimed By", value: "Administrator" }
      ]
    });
    telegramService.sendToUser(clientId, clientTeleMsg).catch(() => {});

    res.status(200).json({
      success: true,
      claimedCount: count,
      message: `Successfully claimed ${count} payout names for ${clientName} (${allocatedUsedCount} from allocated, ${poolIds.length} from available pool)`
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get inventory for a specific subaccount (used by subaccount portal)
const getSubaccountInventory = async (req, res) => {
  try {
    if (req.user.role !== 'subaccount') {
      return res.status(403).json({ message: 'Access denied. Subaccount only.' });
    }

    const subaccountId = req.user.id; // From jwt payload
    const { search } = req.query;

    let filter = {
      status: 'claimed',
      claimedForSubaccount: subaccountId
    };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { accountNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const claimedNames = await PayoutName.find(filter).sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        claimedNames
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Delete a Payout Name
// @route   DELETE /api/payout-names/:id
// @access  Private/Admin
const deletePayoutName = async (req, res) => {
  try {
    const payoutName = await PayoutName.findById(req.params.id);
    
    if (!payoutName) {
      return res.status(404).json({ message: "Payout name not found" });
    }
    
    await payoutName.deleteOne();
    res.status(200).json({ message: "Payout name deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

const SpecificNameRequest = require("../models/SpecificNameRequest");
const Subaccount = require("../models/Subaccount");

// @desc    Client requests a specific payout name
// @route   POST /api/payout-names/specific-request
// @access  Private/Client
const createSpecificNameRequest = async (req, res) => {
  try {
    const { requestedName, subaccountId } = req.body;
    const clientId = req.user.id;

    if (!requestedName || !requestedName.trim()) {
      return res.status(400).json({ message: "Please provide a valid name to request." });
    }

    const trimmedName = requestedName.trim();
    const nameLower = trimmedName.toLowerCase();

    // 1. Check if name already exists in PayoutName collection
    const existingPayoutName = await PayoutName.findOne({ nameLower });
    if (existingPayoutName) {
      return res.status(400).json({ 
        message: `The name '${trimmedName}' is already registered in the system. Please request a different name.` 
      });
    }

    // 2. Check if a pending specific request already exists with that name
    const pendingRequest = await SpecificNameRequest.findOne({ 
      requestedNameLower: nameLower, 
      status: "pending" 
    });
    if (pendingRequest) {
      return res.status(400).json({ 
        message: `A request for '${trimmedName}' is already pending admin review. Please choose another name.` 
      });
    }

    // 3. Verify subaccount if provided
    let targetSubaccount = null;
    if (subaccountId && subaccountId !== "self") {
      const sub = await Subaccount.findOne({ _id: subaccountId, clientId });
      if (!sub) {
        return res.status(404).json({ message: "Selected subaccount not found or does not belong to you." });
      }
      targetSubaccount = sub._id;
    }

    // 4. Create request
    const newRequest = await SpecificNameRequest.create({
      client: clientId,
      requestedName: trimmedName,
      requestedNameLower: nameLower,
      subaccount: targetSubaccount,
      status: "pending",
    });

    const populated = await SpecificNameRequest.findById(newRequest._id)
      .populate("client", "email profile")
      .populate("subaccount", "username");

    // Broadcast to all admins on Telegram
    const clientName = populated?.client?.profile?.firstName 
      ? `${populated.client.profile.firstName} ${populated.client.profile.lastName || ''}`.trim() 
      : (populated?.client?.email || 'A client');

    const adminTeleMsg = telegramService.formatNotification({
      icon: "🏷️",
      title: "New Specific Name Request",
      message: `Client <b>${clientName}</b> has requested a specific payout name: <b>${trimmedName}</b>.`,
      details: [
        { label: "Client", value: `${clientName} (${populated?.client?.email || ''})` },
        { label: "Requested Name", value: trimmedName },
        { label: "Subaccount", value: populated?.subaccount?.username || "Self (Main Account)" }
      ]
    });
    telegramService.sendToAdmins(adminTeleMsg).catch(() => {});

    res.status(201).json({
      success: true,
      message: "Specific name request submitted successfully.",
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Client views their own specific name requests
// @route   GET /api/payout-names/specific-requests/me
// @access  Private/Client
const getClientSpecificNameRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const filter = { client: req.user.id };

    const total = await SpecificNameRequest.countDocuments(filter);
    const requests = await SpecificNameRequest.find(filter)
      .populate("subaccount", "username")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      success: true,
      data: requests,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin views all specific name requests
// @route   GET /api/payout-names/specific-requests
// @access  Private/Admin
const getAllSpecificNameRequests = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const status = req.query.status || "all";
    const search = req.query.search || "";

    const filter = {};
    if (status !== "all") {
      filter.status = status;
    }

    if (search) {
      filter.$or = [
        { requestedName: { $regex: search, $options: "i" } },
        { accountNumber: { $regex: search, $options: "i" } },
      ];
    }

    const total = await SpecificNameRequest.countDocuments(filter);
    const requests = await SpecificNameRequest.find(filter)
      .populate("client", "email profile")
      .populate("subaccount", "username")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({
      success: true,
      data: requests,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin approves specific name request with bank details
// @route   PUT /api/payout-names/specific-requests/:id/approve
// @access  Private/Admin
const approveSpecificNameRequest = async (req, res) => {
  try {
    const { routingNumber, accountNumber } = req.body;
    const requestId = req.params.id;

    if (!routingNumber || !routingNumber.trim() || !accountNumber || !accountNumber.trim()) {
      return res.status(400).json({ message: "Routing number and account number are required to approve." });
    }

    const trimmedRouting = routingNumber.trim();
    const trimmedAccount = accountNumber.trim();

    const request = await SpecificNameRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: "Specific name request not found." });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: `Request is already ${request.status}.` });
    }

    // 1. Check duplicate name in PayoutName
    const dupName = await PayoutName.findOne({ nameLower: request.requestedNameLower });
    if (dupName) {
      return res.status(400).json({ 
        message: `Payout name '${request.requestedName}' already exists in the database.` 
      });
    }

    // 2. Check duplicate account number in PayoutName
    const dupAccount = await PayoutName.findOne({ accountNumber: trimmedAccount });
    if (dupAccount) {
      return res.status(400).json({ 
        message: `A payout name with account number '${trimmedAccount}' already exists in the database.` 
      });
    }

    // 3. Create PayoutName with status 'claimed' directly
    const newPayoutName = await PayoutName.create({
      name: request.requestedName,
      nameLower: request.requestedNameLower,
      routingNumber: trimmedRouting,
      accountNumber: trimmedAccount,
      status: "claimed",
      allocatedTo: request.client,
      claimedForSubaccount: request.subaccount || null,
      paymentStatus: "not_received",
      amount: 0,
    });

    // 4. Update request status to approved
    request.status = "approved";
    request.routingNumber = trimmedRouting;
    request.accountNumber = trimmedAccount;
    request.payoutName = newPayoutName._id;
    await request.save();

    const populated = await SpecificNameRequest.findById(request._id)
      .populate("client", "email profile")
      .populate("subaccount", "username")
      .populate("payoutName");

    // Notify client via Telegram
    const clientTeleMsg = telegramService.formatNotification({
      icon: "🎉",
      title: "Specific Name Request Approved!",
      message: `Your requested payout name <b>${request.requestedName}</b> has been approved and created.`,
      details: [
        { label: "Payout Name", value: request.requestedName },
        { label: "Account Number", value: trimmedAccount },
        { label: "Routing Number", value: trimmedRouting },
        { label: "Subaccount", value: populated?.subaccount?.username || "Self (Main Account)" }
      ]
    });
    telegramService.sendToUser(request.client, clientTeleMsg).catch(() => {});

    res.status(200).json({
      success: true,
      message: "Specific name request approved and claimed payout name created successfully.",
      data: populated,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Duplicate entry detected for name or account number." });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin rejects specific name request
// @route   PUT /api/payout-names/specific-requests/:id/reject
// @access  Private/Admin
const rejectSpecificNameRequest = async (req, res) => {
  try {
    const { adminNote } = req.body;
    const requestId = req.params.id;

    const request = await SpecificNameRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: "Specific name request not found." });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: `Request is already ${request.status}.` });
    }

    request.status = "rejected";
    request.adminNote = adminNote ? adminNote.trim() : "";
    await request.save();

    const populated = await SpecificNameRequest.findById(request._id)
      .populate("client", "email profile")
      .populate("subaccount", "username");

    // Notify client via Telegram
    const clientTeleMsg = telegramService.formatNotification({
      icon: "⚠️",
      title: "Specific Name Request Rejected",
      message: `Your requested payout name <b>${request.requestedName}</b> could not be approved.`,
      details: [
        { label: "Requested Name", value: request.requestedName },
        ...(adminNote ? [{ label: "Reason / Note", value: adminNote }] : [])
      ]
    });
    telegramService.sendToUser(request.client, clientTeleMsg).catch(() => {});

    res.status(200).json({
      success: true,
      message: "Specific name request rejected.",
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Admin directly creates a specific payout name for a client
// @route   POST /api/payout-names/admin/create-specific
// @access  Private/Admin
const adminCreateSpecificPayoutName = async (req, res) => {
  try {
    const { clientId, name, accountNumber, routingNumber, subaccountId } = req.body;

    if (!clientId) {
      return res.status(400).json({ message: "Client ID is required" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Payout name is required" });
    }

    if (!accountNumber || !accountNumber.trim()) {
      return res.status(400).json({ message: "Account number is required" });
    }

    if (!routingNumber || !routingNumber.trim()) {
      return res.status(400).json({ message: "Routing number is required" });
    }

    const trimmedName = name.trim();
    const nameLower = trimmedName.toLowerCase();
    const trimmedAccount = accountNumber.trim();
    const trimmedRouting = routingNumber.trim();

    // Verify client exists
    const clientUser = await User.findById(clientId).select('email profile');
    if (!clientUser) {
      return res.status(404).json({ message: "Client not found" });
    }

    // Verify subaccount if provided
    let claimedForSubaccount = null;
    let subaccountDoc = null;
    if (subaccountId && subaccountId !== 'self') {
      subaccountDoc = await Subaccount.findOne({ _id: subaccountId, clientId });
      if (!subaccountDoc) {
        return res.status(404).json({ message: "Selected subaccount not found or does not belong to this client" });
      }
      claimedForSubaccount = subaccountDoc._id;
    }

    // Duplicate check on name
    const dupName = await PayoutName.findOne({ nameLower });
    if (dupName) {
      return res.status(400).json({ 
        message: `Payout name '${trimmedName}' already exists in the database. Please provide a different name.` 
      });
    }

    // Duplicate check on account number
    const dupAccount = await PayoutName.findOne({ accountNumber: trimmedAccount });
    if (dupAccount) {
      return res.status(400).json({ 
        message: `A payout name with account number '${trimmedAccount}' already exists in the database.` 
      });
    }

    // Create the PayoutName with status 'claimed' directly
    const newPayoutName = await PayoutName.create({
      name: trimmedName,
      nameLower,
      routingNumber: trimmedRouting,
      accountNumber: trimmedAccount,
      status: "claimed",
      allocatedTo: clientId,
      claimedForSubaccount,
      paymentStatus: "not_received",
      amount: 0,
    });

    // Create an approved SpecificNameRequest record for audit trail & history
    await SpecificNameRequest.create({
      client: clientId,
      requestedName: trimmedName,
      requestedNameLower: nameLower,
      subaccount: claimedForSubaccount,
      status: "approved",
      routingNumber: trimmedRouting,
      accountNumber: trimmedAccount,
      payoutName: newPayoutName._id,
      adminNote: "Directly created by administrator",
    });

    const populated = await PayoutName.findById(newPayoutName._id)
      .populate('allocatedTo', 'email profile')
      .populate('claimedForSubaccount', 'username');

    // Notify client via Telegram
    const clientName = clientUser?.profile?.firstName 
      ? `${clientUser.profile.firstName} ${clientUser.profile.lastName || ''}`.trim() 
      : clientUser.email;
    const targetLabel = subaccountDoc ? subaccountDoc.username : "Main Account (Self)";

    const clientTeleMsg = telegramService.formatNotification({
      icon: "🎉",
      title: "Specific Payout Name Created!",
      message: `A specific payout name <b>${trimmedName}</b> has been created and claimed for your account (Target: <b>${targetLabel}</b>).`,
      details: [
        { label: "Payout Name", value: trimmedName },
        { label: "Account Number", value: trimmedAccount },
        { label: "Routing Number", value: trimmedRouting },
        { label: "Subaccount", value: targetLabel }
      ]
    });
    telegramService.sendToUser(clientId, clientTeleMsg).catch(() => {});

    res.status(201).json({
      success: true,
      message: `Specific payout name '${trimmedName}' created and claimed successfully for ${clientName}`,
      data: populated
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Duplicate entry detected for name or account number." });
    }
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

module.exports = {
  uploadPayoutNames,
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
};
