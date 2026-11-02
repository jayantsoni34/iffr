const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');
const ExcelJS = require('exceljs');

// Initialize Express app
const app = express();
const cache = new NodeCache({ stdTTL: 36000 });

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(compression());

// MongoDB Connection
const dbURI = 'mongodb+srv://oshan:oshan%40work1234@cluster0.2txxi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });

// Schema
const taskSchema = new mongoose.Schema({
  complaintNumber: { type: String, index: true },
  name: String,
  email: String,
  phone: String,
  altPhone: String,
  state: String,
  city: String,
  pincode: String,
  location: String,
  landmark: String,
  product: String,
  selectedModel: {
    model: String,
    capacity: String,
    warranty: Number
  },
  serialNumber: String,
  warrantyStatus: {
    status: String,
    expiryDate: String
  },
  purchaseDate: String,
  installationDate: String,
  callType: String,
  condition: String,
  callSource: String,
  taskStatus: String,
  assignEngineer: String,
  contactNo: String,
  dealer: String,
  date: { type: String, index: true }, // <-- indexed for fast date-range export
  asp: String,
  aspName: String,
  actionTaken: String,
  customerFeedback: String,
  enginnerNotes: String,
  images: [String],
  status: String,
  complaintNotes: String,
  additionalStatus: String,
  generatedOtps: String,
}, { timestamps: true });

const Task = mongoose.model('Task', taskSchema);

/* ------------------------------------------------------------- */
/* Helpers — shared query builder for /tasks and /tasks/export    */
/* ------------------------------------------------------------- */
function buildTaskQuery(query) {
  const { startDate, endDate, product, callType, callSource, status, state, search } = query;
  const filter = {};

  if (startDate && endDate) {
    filter.date = { $gte: startDate, $lte: endDate };
  } else if (startDate) {
    filter.date = { $gte: startDate };
  } else if (endDate) {
    filter.date = { $lte: endDate };
  }

  if (product)    filter.product    = product;
  if (callType)   filter.callType   = callType;
  if (callSource) filter.callSource = callSource;
  if (status) {
    if (status === 'Assigned/Pending') {
      filter.taskStatus = { $in: ['Assigned', 'Pending'] };
    } else {
      filter.taskStatus = status;
    }
  }
  if (state) filter.state = state;

  if (search && search.trim()) {
    const rx = new RegExp(search.trim(), 'i');
    filter.$or = [
      { name: rx },
      { location: rx },
      { city: rx },
      { phone: rx },
      { complaintNumber: rx },
    ];
  }

  return filter;
}

function daysBetween(start, end) {
  if (!start || !end) return '-';
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s) || isNaN(e)) return '-';
  return Math.floor((e - s) / 86400000);
}

function pendingDays(start) {
  if (!start) return '-';
  const s = new Date(start);
  if (isNaN(s)) return '-';
  return Math.floor((Date.now() - s) / 86400000);
}

/* ------------------------------------------------------------- */
/* Add new task                                                   */
/* ------------------------------------------------------------- */
app.post('/tasks', async (req, res) => {
  try {
    const task = new Task(req.body);
    await task.save();
    cache.del('allTasks');
    res.status(201).json(task);
  } catch (err) {
    console.error('Error saving task:', err);
    res.status(500).json({ error: 'Failed to save task.' });
  }
});

/* ------------------------------------------------------------- */
/* Get all tasks (paginated, filtered)                            */
/* ------------------------------------------------------------- */
app.get('/tasks', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const filter = buildTaskQuery(req.query);

    const [totalTasks, tasks] = await Promise.all([
      Task.countDocuments(filter),
      Task.find(filter)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.status(200).json({
      tasks,
      totalTasks,
      currentPage: page,
      totalPages: Math.ceil(totalTasks / limit),
    });
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks. Please try again.' });
  }
});

/* ------------------------------------------------------------- */
/* ✅ NEW — Stream Excel export directly (no JSON, no client xlsx) */
/* ------------------------------------------------------------- */
app.get('/tasks/export', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const filter = buildTaskQuery(req.query);

    // Stream the response straight to the client
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Tasks_${startDate || 'all'}_to_${endDate || 'all'}.xlsx"`
    );

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
    });
    const sheet = workbook.addWorksheet('Tasks');

    sheet.columns = [
      { header: '#',                     key: 'idx',              width: 6  },
      { header: 'Complaint Number',      key: 'complaintNumber',  width: 20 },
      { header: 'Name',                  key: 'name',             width: 22 },
      { header: 'Phone',                 key: 'phone',            width: 15 },
      { header: 'Complaint Status',      key: 'taskStatus',       width: 18 },
      { header: 'Additional Status',     key: 'additionalStatus', width: 18 },
      { header: 'State',                 key: 'state',            width: 15 },
      { header: 'City',                  key: 'city',             width: 15 },
      { header: 'Address',               key: 'location',         width: 32 },
      { header: 'Pincode',               key: 'pincode',          width: 10 },
      { header: 'Product',               key: 'product',          width: 15 },
      { header: 'Model',                 key: 'model',            width: 15 },
      { header: 'Serial Number',         key: 'serialNumber',     width: 18 },
      { header: 'Warranty Status',       key: 'warrantyStatus',   width: 16 },
      { header: 'Warranty Expiry',       key: 'warrantyExpiry',   width: 16 },
      { header: 'Call Type',             key: 'callType',         width: 12 },
      { header: 'Call Source',           key: 'callSource',       width: 12 },
      { header: 'Dealer',                key: 'dealer',           width: 15 },
      { header: 'Engineer',              key: 'assignEngineer',   width: 18 },
      { header: 'Distt',                 key: 'contactNo',        width: 15 },
      { header: 'Complaint Registered',  key: 'date',             width: 20 },
      { header: 'Final Close Date',      key: 'actionTaken',      width: 20 },
      { header: 'Problem',               key: 'complaintNotes',   width: 32 },
      { header: 'Engineer Action',       key: 'enginnerNotes',    width: 32 },
      { header: 'Open (Days)',           key: 'openDays',         width: 12 },
      { header: 'Ageing',                key: 'ageing',           width: 12 },
      { header: 'Customer Feedback',     key: 'customerFeedback', width: 25 },
    ];

    // Style the header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();

    // Stream rows using a cursor — never buffers entire result in RAM
    const cursor = Task.find(filter).sort({ _id: -1 }).lean().cursor();

    let idx = 0;
    for await (const t of cursor) {
      idx += 1;
      sheet.addRow({
        idx,
        complaintNumber:  t.complaintNumber || 'N/A',
        name:             t.name || 'N/A',
        phone:            t.phone || 'N/A',
        taskStatus:       t.taskStatus || 'N/A',
        additionalStatus: t.additionalStatus || 'N/A',
        state:            t.state || 'N/A',
        city:             t.city || 'N/A',
        location:         t.location || 'N/A',
        pincode:          t.pincode || 'N/A',
        product:          t.product || 'N/A',
        model:            t.selectedModel?.model || 'N/A',
        serialNumber:     t.serialNumber || 'N/A',
        warrantyStatus:   t.warrantyStatus?.status || 'N/A',
        warrantyExpiry:   t.warrantyStatus?.expiryDate || 'N/A',
        callType:         t.callType || 'N/A',
        callSource:       t.callSource || 'N/A',
        dealer:           t.dealer || 'N/A',
        assignEngineer:   t.assignEngineer || 'N/A',
        contactNo:        t.contactNo || 'N/A',
        date:             t.date || 'N/A',
        actionTaken:      t.actionTaken || 'N/A',
        complaintNotes:   t.complaintNotes || 'N/A',
        enginnerNotes:    t.enginnerNotes || 'N/A',
        openDays:         daysBetween(t.date, t.actionTaken),
        ageing:           t.taskStatus !== 'Resolved' ? pendingDays(t.date) : 'Closed',
        customerFeedback: t.customerFeedback || 'N/A',
      }).commit();
    }

    await workbook.commit();
  } catch (err) {
    console.error('Error exporting tasks:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export tasks.' });
    } else {
      res.end();
    }
  }
});

/* ------------------------------------------------------------- */
/* Update task                                                    */
/* ------------------------------------------------------------- */
app.put('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    cache.del('allTasks');
    res.status(200).json(task);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

/* ------------------------------------------------------------- */
/* Delete task                                                    */
/* ------------------------------------------------------------- */
app.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    cache.del('allTasks');
    res.status(200).json({ message: 'Task deleted successfully' });
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Failed to delete task.' });
  }
});

// Start Server
const port = process.env.PORT || 5002;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
