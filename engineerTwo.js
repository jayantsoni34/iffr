const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();

/* ================== MIDDLEWARE ================== */
app.use(cors());
app.use(express.json());

/* ================== ENV ================== */
const PORT = process.env.PORT || 5001;

/* ================== MongoDB Connection ================== */
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Atlas Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

/* ================== Schemas ================== */
const roundSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["Assigned", "Pending", "Resolved"],
      default: "Assigned",
    },
    additionalStatus: { type: String, default: "Action Required" },
    additionalOptions: {
      type: [String],
      default: [
        "Action Required",
        "Forward",
        "Specialist Assignment",
        "Investigation",
      ],
    },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    timeIn: { type: String, default: "" },
    timeOut: { type: String, default: "" },
    mode: { type: String, default: "" },
    km: { type: String, default: "" },
    amount: { type: String, default: "" },
    problem: { type: String, default: "" },
    actionTaken: { type: String, default: "" },
    serial: { type: String, default: "" },
    otp: { type: String, default: "" },
    dop: { type: String, default: "" },
    invoice: { type: String, default: "" },
    time: { type: String, default: () => new Date().toLocaleString() },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    complaintNumber: { type: String, index: true },
    assignEngineer: { type: String, index: true },

    /* ---- top-level status (synced with latest round) ---- */
    taskStatus: {
      type: String,
      enum: ["Assigned", "Pending", "Resolved"],
      default: "Assigned",
      index: true,
    },
    additionalStatus: { type: String, default: "" },

    /* ---- synced from latest round ---- */
    dop: { type: String, default: "" },
    serial: { type: String, default: "" },
    invoice: { type: String, default: "" },

    /* ---- complaint metadata ---- */
    date: { type: String, index: true },
    name: String,
    phone: String,
    state: String,
    city: String,
    pincode: String,
    product: String,
    selectedModel: { model: String },
    serialNumber: String,
    dealer: String,
    location: String,

    /* ---- rounds history ---- */
    rounds: { type: [roundSchema], default: [] },
  },
  { timestamps: true }
);

const Task = mongoose.model("Task", taskSchema);

/* ================== ROUTES ================== */

// ✅ Health check
app.get("/", (req, res) => {
  res.send("🚀 API is running...");
});

/* ============================================================
   GET ALL TASKS — PAGINATED + FILTERS + SEARCH
============================================================ */
app.get("/tasks", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const {
      search,
      status,
      engineer,
      month,
      year,
      sort = "createdAt",
      order = "desc",
    } = req.query;

    const filter = {};

    if (status && status !== "All") filter.taskStatus = status;
    if (engineer && engineer !== "All") filter.assignEngineer = engineer;

    /* ============ MONTH + YEAR FILTER ============ */
    if (month && year) {
      const mm = String(month).padStart(2, "0");
      const yyyy = String(year);

      filter.$or = [
        { date: { $regex: `/${mm}/${yyyy}$` } },
        { date: { $regex: `-${mm}-${yyyy}$` } },
        { date: { $regex: `^${yyyy}-${mm}` } },
        { date: { $regex: `^${yyyy}/${mm}` } },
      ];
    }

    /* ============ SEARCH ============ */
    if (search) {
      const regex = new RegExp(search, "i");
      const searchOr = [
        { complaintNumber: regex },
        { name: regex },
        { phone: regex },
        { title: regex },
        { assignEngineer: regex },
      ];

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    const sortObj = { [sort]: order === "asc" ? 1 : -1 };

    const [tasks, total] = await Promise.all([
      Task.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      Task.countDocuments(filter),
    ]);

    res.json({
      data: tasks,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   GET SINGLE TASK
============================================================ */
app.get("/tasks/:taskId", async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CREATE NEW TASK
   If a first round is included, mirror its status upward.
============================================================ */
app.post("/tasks", async (req, res) => {
  try {
    const payload = { ...req.body };

    if (Array.isArray(payload.rounds) && payload.rounds.length > 0) {
      const last = payload.rounds[payload.rounds.length - 1];
      payload.taskStatus = last.status || "Assigned";
      payload.additionalStatus = last.additionalStatus || "";
      payload.dop = last.dop || "";
      payload.serial = last.serial || "";
      payload.invoice = last.invoice || "";
    }

    const task = new Task(payload);
    const saved = await task.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ADD ROUND TO TASK — THE KEY ROUTE
   Persists the new round AND syncs task-level fields in one write.
============================================================ */
app.post("/tasks/:taskId/round", async (req, res) => {
  try {
    const { taskId } = req.params;
    const round = req.body;

    if (!round || !round.status) {
      return res.status(400).json({ error: "Round status is required." });
    }

    const updatedTask = await Task.findByIdAndUpdate(
      taskId,
      [
        {
          $set: {
            rounds: {
              $concatArrays: [{ $ifNull: ["$rounds", []] }, [round]],
            },
            taskStatus: round.status,
            additionalStatus: round.additionalStatus || "",
            dop: round.dop || "",
            serial: round.serial || "",
            invoice: round.invoice || "",
          },
        },
      ],
      { new: true, runValidators: true }
    );

    if (!updatedTask) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.json(updatedTask);
  } catch (err) {
    console.error("Add round error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   DELETE TASK
============================================================ */
app.delete("/tasks/:taskId", async (req, res) => {
  try {
    const deleted = await Task.findByIdAndDelete(req.params.taskId);
    if (!deleted) return res.status(404).json({ error: "Task not found" });
    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================== SERVER ================== */
app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});


// const express = require("express");
// const mongoose = require("mongoose");
// const cors = require("cors");
// require("dotenv").config();

// const app = express();

// /* ================== MIDDLEWARE ================== */
// app.use(cors());
// app.use(express.json());

// /* ================== ENV ================== */
// const PORT = process.env.PORT || 5001;

// /* ================== MongoDB Connection ================== */
// mongoose.connect(process.env.MONGO_URI, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// })
// .then(() => console.log("✅ MongoDB Atlas Connected"))
// .catch(err => {
//   console.error("❌ MongoDB Connection Error:", err.message);
//   process.exit(1);
// });

// /* ================== Schema ================== */
// const roundSchema = new mongoose.Schema({
//   status: {
//     type: String,
//     enum: ["Assigned", "Pending", "Resolved"],
//     default: "Assigned",
//   },
//   additionalStatus: { type: String, default: "Action Required" },
//   additionalOptions: {
//     type: [String],
//     default: [
//       "Action Required",
//       "Forward",
//       "Specialist Assignment",
//       "Investigation",
//     ],
//   },
//   from: { type: String, default: "" },
//   to: { type: String, default: "" },
//   timeIn: { type: String, default: "" },
//   timeOut: { type: String, default: "" },
//   mode: { type: String, default: "" },
//   km: { type: String, default: "" },
//   amount: { type: String, default: "" },
//   problem: { type: String, default: "" },
//   actionTaken: { type: String, default: "" },
//   serial: { type: String, default: "" },
//   otp: { type: String, default: "" },
//   dop: { type: String, default: "" },
//   invoice: { type: String, default: "" },
//   time: { type: String, default: () => new Date().toLocaleString() },
//   location: {
//     lat: { type: Number, default: null },
//     lng: { type: Number, default: null },
//   },
// }, { timestamps: true });

// const taskSchema = new mongoose.Schema({
//   title: { type: String, default: "" },
//   description: { type: String, default: "" },
//   complaintNumber: String,
//   assignEngineer: String,
//   taskStatus: String,
//   additionalStatus: String,
//   date: String,
//   name: String,
//   phone: String,
//   state: String,
//   product: String,
//   selectedModel: { model: String },
//   rounds: [roundSchema],
// }, { timestamps: true });

// const Task = mongoose.model("Task", taskSchema);

// /* ================== ROUTES ================== */

// // ✅ Health check
// app.get("/", (req, res) => {
//   res.send("🚀 API is running...");
// });

// /* ============================================================
//    🔹 GET ALL TASKS — PAGINATED + MONTH/YEAR + SEARCH + STATUS
//    Rounds ARE included (no .select("-rounds") anywhere)
// ============================================================ */
// app.get("/tasks", async (req, res) => {
//   try {
//     const page = Math.max(parseInt(req.query.page) || 1, 1);
//     const limit = Math.min(parseInt(req.query.limit) || 20, 100);
//     const skip = (page - 1) * limit;

//     const {
//       search,
//       status,
//       engineer,
//       month,
//       year,
//       sort = "createdAt",
//       order = "desc",
//     } = req.query;

//     const filter = {};

//     if (status && status !== "All") {
//       filter.taskStatus = status;
//     }

//     if (engineer && engineer !== "All") {
//       filter.assignEngineer = engineer;
//     }

//     /* ============ MONTH + YEAR FILTER ============ */
//     // task.date is stored as a STRING (e.g. "19/09/2025" or "2025-09-19")
//     if (month && year) {
//       const mm = String(month).padStart(2, "0");
//       const yyyy = String(year);

//       filter.$or = [
//         { date: { $regex: `/${mm}/${yyyy}$` } },   // DD/MM/YYYY
//         { date: { $regex: `-${mm}-${yyyy}$` } },   // DD-MM-YYYY
//         { date: { $regex: `^${yyyy}-${mm}` } },    // YYYY-MM-DD
//         { date: { $regex: `^${yyyy}/${mm}` } },    // YYYY/MM/DD
//       ];
//     }

//     /* ============ SEARCH ============ */
//     if (search) {
//       const regex = new RegExp(search, "i");
//       const searchOr = [
//         { complaintNumber: regex },
//         { name: regex },
//         { phone: regex },
//         { title: regex },
//         { assignEngineer: regex },
//       ];

//       if (filter.$or) {
//         filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
//         delete filter.$or;
//       } else {
//         filter.$or = searchOr;
//       }
//     }

//     const sortObj = { [sort]: order === "asc" ? 1 : -1 };

//     // ✅ Parallel query for speed. NO .select("-rounds") → rounds ARE returned
//     const [tasks, total] = await Promise.all([
//       Task.find(filter)
//         .sort(sortObj)
//         .skip(skip)
//         .limit(limit)
//         .lean(),
//       Task.countDocuments(filter),
//     ]);

//     res.json({
//       data: tasks,
//       pagination: {
//         total,
//         page,
//         limit,
//         totalPages: Math.ceil(total / limit),
//         hasNext: page * limit < total,
//         hasPrev: page > 1,
//       },
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // 🔹 Get single task
// app.get("/tasks/:taskId", async (req, res) => {
//   try {
//     const task = await Task.findById(req.params.taskId);
//     if (!task) return res.status(404).json({ error: "Task not found" });
//     res.json(task);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // 🔹 Create new task
// app.post("/tasks", async (req, res) => {
//   try {
//     const task = new Task(req.body);
//     const saved = await task.save();
//     res.status(201).json(saved);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // 🔹 Add round to task
// app.post("/tasks/:taskId/round", async (req, res) => {
//   try {
//     const { taskId } = req.params;

//     const updatedTask = await Task.findByIdAndUpdate(
//       taskId,
//       { $push: { rounds: req.body } },
//       { new: true }
//     );

//     if (!updatedTask) {
//       return res.status(404).json({ error: "Task not found" });
//     }

//     res.json(updatedTask);
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // 🔹 Delete task
// app.delete("/tasks/:taskId", async (req, res) => {
//   try {
//     await Task.findByIdAndDelete(req.params.taskId);
//     res.json({ message: "Task deleted" });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// /* ================== SERVER ================== */
// app.listen(PORT, () => {
//   console.log(`🔥 Server running on port ${PORT}`);
// });
