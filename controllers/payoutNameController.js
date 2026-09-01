const PayoutName = require("../models/PayoutName");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");

// @desc    Upload Payout Names via CSV
// @route   POST /api/payout-names/upload
// @access  Private/Admin
const uploadPayoutNames = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload a CSV file." });
    }

    const results = [];
    const errors = [];
    let duplicates = 0;
    let added = 0;

    // Read and parse the CSV
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", async () => {
        // Iterate through parsed results
        for (const row of results) {
          // Normalize column names by trimming and lowercase (to handle variations like 'Name ', 'routing number', etc.)
          const keys = Object.keys(row);
          let name = null;
          let routingNumber = null;
          let accountNumber = null;

          for (const key of keys) {
            const lowerKey = key.trim().toLowerCase();
            if (lowerKey === "name") name = row[key].trim();
            else if (lowerKey === "routing number" || lowerKey === "routingnumber") routingNumber = row[key].trim();
            else if (lowerKey === "account number" || lowerKey === "accountnumber") accountNumber = row[key].trim();
          }

          if (!name || !routingNumber || !accountNumber) {
            errors.push(`Row missing required fields (name, routingNumber, accountNumber): ${JSON.stringify(row)}`);
            continue;
          }

          const nameLower = name.toLowerCase();

          try {
            // Check for existing
            const existing = await PayoutName.findOne({ nameLower });
            if (existing) {
              duplicates++;
              errors.push(`Duplicate name found in database: '${name}'`);
              continue;
            }

            // Create new
            await PayoutName.create({
              name,
              nameLower,
              routingNumber,
              accountNumber,
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

        // Clean up the uploaded file
        fs.unlinkSync(req.file.path);

        res.status(200).json({
          message: "Upload processing completed",
          report: {
            totalProcessed: results.length,
            added,
            duplicates,
            errors,
          },
        });
      })
      .on("error", (error) => {
        fs.unlinkSync(req.file.path);
        res.status(500).json({ message: "Error parsing CSV file", error: error.message });
      });

  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: "Server error", error: error.message });
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

    const total = await PayoutName.countDocuments(query);
    const payoutNames = await PayoutName.find(query)
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

// Claim allocated names
const claimPayoutNames = async (req, res) => {
  try {
    const clientId = req.user.id;
    const { count, subaccountId } = req.body;
    
    if (!count || count <= 0) {
      return res.status(400).json({ message: 'Invalid count provided' });
    }

    // Verify subaccount if provided
    let claimedForSubaccount = null;
    if (subaccountId && subaccountId !== 'self') {
      const Subaccount = require('../models/Subaccount');
      const subaccount = await Subaccount.findOne({ _id: subaccountId, clientId });
      if (!subaccount) {
        return res.status(404).json({ message: 'Subaccount not found or does not belong to you' });
      }
      claimedForSubaccount = subaccount._id;
    }

    // Find allocated names for this client
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

    res.status(200).json({ success: true, claimedCount: count, message: `Successfully claimed ${count} payout names` });
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
  getSubaccountInventory
};
