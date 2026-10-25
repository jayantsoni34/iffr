require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const app = express();

app.use(cors());
app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 5000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// ---------- MongoDB ----------
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err.message));

// ---------- Cloudinary ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "expense-management",
    resource_type: "auto",
    public_id: `${Date.now()}-${file.originalname}`,
  }),
});

const upload = multer({ storage });

// ---------- Schema ----------
const ExpenseSchema = new mongoose.Schema(
  {
    username: String,
    date: String,
    visitDate: String,
    expenseType: String,
    complaintNo: String,
    mainfrom: String,
    mainto: String,
    dealerName: String,

    travelDetails: [
      {
        travelMode: String,
        fromLocation: String,
        toLocation: String,
        startReading: Number,
        endReading: Number,
        totalKm: Number,
        startMeterImage: String,
        endMeterImage: String,
        travelBill: String,
        fareAmount: Number,
      },
    ],
    hotelName: String,
    hotelBill: String,
    accommodationAmount: Number,
    foodBill: String,
    foodAmount: Number,
    courierCompany: String,
    courierBill: String,
    courierAmount: Number,
    miscDescription: String,
    miscBill: String,
    miscAmount: Number,
    totalExpense: Number,
    status: {
      type: String,
      default: "Pending",
    },
  },
  { timestamps: true }
);

// Indexes for fast pagination + filters
ExpenseSchema.index({ createdAt: -1 });
ExpenseSchema.index({ username: 1 });

const Expense = mongoose.model("Expense", ExpenseSchema);

// ---------- POST Expense ----------
app.post("/api/expenses", upload.any(), async (req, res) => {
  try {
    const files = req.files || [];

    let travelDetails = JSON.parse(req.body.travelDetails || "[]");

    travelDetails = travelDetails.map((route, index) => {
      const startMeter = files.find(
        (file) => file.fieldname === `startMeterImage_${index}`
      );
      const endMeter = files.find(
        (file) => file.fieldname === `endMeterImage_${index}`
      );
      const travelBill = files.find(
        (file) => file.fieldname === `travelBill_${index}`
      );

      return {
        ...route,
        startMeterImage: startMeter?.path || "",
        endMeterImage: endMeter?.path || "",
        travelBill: travelBill?.path || "",
      };
    });

    const hotelBill =
      files.find((f) => f.fieldname === "hotelBill")?.path || "";
    const foodBill =
      files.find((f) => f.fieldname === "foodBill")?.path || "";
    const courierBill =
      files.find((f) => f.fieldname === "courierBill")?.path || "";
    const miscBill =
      files.find((f) => f.fieldname === "miscBill")?.path || "";

    const travelTotal = travelDetails.reduce((sum, route) => {
      if (route.travelMode === "Bike" || route.travelMode === "Car") {
        const km = Number(route.totalKm || 0);
        const rate = route.travelMode === "Bike" ? 3 : 7;
        return sum + km * rate;
      }
      return sum + Number(route.fareAmount || 0);
    }, 0);

    const accommodationAmount = Number(req.body.accommodationAmount || 0);
    const foodAmount = Number(req.body.foodAmount || 0);
    const courierAmount = Number(req.body.courierAmount || 0);
    const miscAmount = Number(req.body.miscAmount || 0);

    const totalExpense =
      travelTotal + accommodationAmount + foodAmount + courierAmount + miscAmount;

    const expense = await Expense.create({
      username: req.body.username,
      date: req.body.date,
      visitDate: req.body.visitDate,
      expenseType: req.body.expenseType,
      complaintNo: req.body.complaintNo,
      mainfrom: req.body.mainfrom,
      mainto: req.body.mainto,
      dealerName: req.body.dealerName,

      travelDetails,

      hotelName: req.body.hotelName,
      hotelBill,
      accommodationAmount,

      foodBill,
      foodAmount,

      courierCompany: req.body.courierCompany,
      courierBill,
      courierAmount,

      miscDescription: req.body.miscDescription,
      miscBill,
      miscAmount,
      totalExpense,
    });

    res.status(201).json({
      success: true,
      message: "Expense Saved Successfully",
      data: expense,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ---------- GET Expenses (paginated, 30 / page) ----------
// Query params: ?page=1&limit=30&username=XYZ&status=Pending&from=2026-10-01&to=2026-10-21
app.get("/api/expenses", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const skip = (page - 1) * limit;

    // Build filter
    const filter = {};
    if (req.query.username) filter.username = req.query.username.trim();
    if (req.query.status) filter.status = req.query.status;
    if (req.query.expenseType) filter.expenseType = req.query.expenseType;

    // Date range — uses createdAt (real Date field), not the "date" string
    if (req.query.from || req.query.to) {
      const from = req.query.from ? new Date(req.query.from) : new Date("1970-01-01");
      const to = req.query.to ? new Date(req.query.to) : new Date();
      to.setHours(23, 59, 59, 999);

      if (isNaN(from) || isNaN(to)) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Use YYYY-MM-DD.",
        });
      }
      filter.createdAt = { $gte: from, $lte: to };
    }

    const [expenses, total] = await Promise.all([
      Expense.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Expense.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      data: expenses,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ---------- DELETE Expense ----------
app.delete("/api/expenses/:id", async (req, res) => {
  try {
    await Expense.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Expense Deleted" });
  } catch (err) {
    res.status(500).json(err);
  }
});

// ---------- UPDATE Status ----------
app.patch("/api/expenses/:id/status", async (req, res) => {
  try {
    const expense = await Expense.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    res.json({ success: true, data: expense });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ---------- Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server Running on port ${PORT}`);
});
