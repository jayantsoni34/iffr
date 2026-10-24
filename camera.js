const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const sharp = require("sharp");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ---------- Config ----------
const TZ = "Asia/Kolkata";
const PORT = process.env.PORT || 5000;
const IMG_MAX_WIDTH = 800;
const IMG_MAX_HEIGHT = 800;
const IMG_QUALITY = 70;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

// ---------- MongoDB ----------
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("✅ MongoDB Atlas Linked Successfully"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

let gridFSBucket = null;
mongoose.connection.once("open", () => {
  gridFSBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "attendanceImages",
  });
  console.log("✅ MongoDB GridFS Ready");
});

mongoose.connection.on("error", (e) => console.error("Mongo runtime error:", e.message));
mongoose.connection.on("disconnected", () => console.warn("⚠️ MongoDB disconnected"));

// ---------- Helpers ----------
const getIndiaDateTime = () => {
  const now = new Date();
  return {
    date: now.toLocaleDateString("en-IN", { timeZone: TZ }),
    time: now.toLocaleTimeString("en-IN", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit",
      second: "2-digit", hour12: true,
    }),
  };
};

/**
 * Build absolute URL for a GridFS image.
 * Works behind Render/Heroku/Vercel proxies because we read X-Forwarded-* headers.
 */
const buildImageUrl = (req, fileId) => {
  if (!fileId) return "";
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/api/images/${fileId}`;
};

const compressImage = async (imageBase64) => {
  const buffer = Buffer.from(
    imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );
  const out = await sharp(buffer)
    .rotate()
    .resize({
      width: IMG_MAX_WIDTH,
      height: IMG_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: IMG_QUALITY })
    .toBuffer();

  console.log(
    `🖼️  Image: ${(buffer.length / 1024).toFixed(2)}KB → ${(out.length / 1024).toFixed(2)}KB`
  );
  return out;
};

const saveImageToGridFS = (buffer, username, actionType) =>
  new Promise((resolve, reject) => {
    if (!gridFSBucket) return reject(new Error("GridFS not ready."));
    const filename = `attendance_${username}_${actionType}_${Date.now()}.webp`;
    const upload = gridFSBucket.openUploadStream(filename, {
      contentType: "image/webp",
      metadata: {
        username: username.toUpperCase(),
        actionType,
        uploadedAt: new Date(),
      },
    });
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    upload.end(buffer);
  });

const deleteGridFSImage = async (fileId) => {
  if (!fileId || !gridFSBucket) return;
  try {
    await gridFSBucket.delete(new mongoose.Types.ObjectId(fileId));
    console.log("🗑️  GridFS image deleted:", String(fileId));
  } catch (e) {
    console.error("GridFS delete error:", e.message);
  }
};

const csvEscape = (val) => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

// ---------- Guard: GridFS must be ready ----------
// Prevents 500s on the first request after a Render cold start.
app.use((req, res, next) => {
  if (
    !gridFSBucket &&
    (req.path.startsWith("/api/attendance") || req.path.startsWith("/api/images"))
  ) {
    return res
      .status(503)
      .json({ error: "Storage not ready yet. Please retry in 1–2 seconds." });
  }
  next();
});

// ---------- Schema ----------
const Attendance = mongoose.model("Attendance", new mongoose.Schema({
  username: { type: String, required: true, uppercase: true, trim: true },
  date: { type: String, required: true },
  timeIn: { type: String, default: "" },
  locationIn: { type: String, default: "" },
  photoIn: { type: mongoose.Schema.Types.ObjectId, default: null },
  timeOut: { type: String, default: "Awaiting Log" },
  locationOut: { type: String, default: "Awaiting Log" },
  photoOut: { type: mongoose.Schema.Types.ObjectId, default: null },
  status: { type: String, enum: ["PENDING", "COMPLETED"], default: "PENDING" },
}, { timestamps: true }));

Attendance.collection.createIndex({ username: 1, date: 1 });
Attendance.collection.createIndex({ createdAt: -1 });

// ---------- POST Attendance ----------
app.post("/api/attendance", async (req, res) => {
  let uploadedImageId = null; // for rollback if DB write fails
  try {
    const { username, imageBase64, latitude, longitude, actionType } = req.body;

    if (!username) return res.status(400).json({ error: "Username is required." });
    if (!imageBase64) return res.status(400).json({ error: "Selfie image is required." });
    if (latitude == null || longitude == null)
      return res.status(400).json({ error: "GPS location is required." });
    if (!["in", "out"].includes(actionType))
      return res.status(400).json({ error: "Invalid attendance action." });

    const user = username.toUpperCase().trim();
    const { date, time } = getIndiaDateTime();
    const telemetry = `Lat: ${Number(latitude).toFixed(4)}, Lon: ${Number(longitude).toFixed(4)}`;

    const existing = await Attendance.findOne({ username: user, date });

    // ---------- CHECK-IN ----------
    if (actionType === "in") {
      if (existing)
        return res.status(400).json({
          error: `You have already checked in today at ${existing.timeIn}.`,
        });

      uploadedImageId = await saveImageToGridFS(
        await compressImage(imageBase64), user, "in"
      );

      const record = await Attendance.create({
        username: user, date, timeIn: time,
        locationIn: telemetry, photoIn: uploadedImageId,
      });

      return res.status(201).json({
        message: `Check-In documented successfully at ${time}.`,
        data: {
          id: record._id,
          username: user,
          date,
          time,
          location: telemetry,
          photo: buildImageUrl(req, uploadedImageId),
          status: "PENDING",
        },
      });
    }

    // ---------- CHECK-OUT ----------
    if (!existing)
      return res.status(400).json({
        error: "No Check-In record found for today. Please Check-In first.",
      });

    if (existing.timeOut && existing.timeOut !== "Awaiting Log")
      return res.status(400).json({
        error: `You have already checked out today at ${existing.timeOut}.`,
      });

    uploadedImageId = await saveImageToGridFS(
      await compressImage(imageBase64), user, "out"
    );

    Object.assign(existing, {
      timeOut: time,
      locationOut: telemetry,
      photoOut: uploadedImageId,
      status: "COMPLETED",
    });
    await existing.save();

    return res.status(200).json({
      message: `Check-Out documented successfully at ${time}.`,
      data: {
        id: existing._id,
        username: user,
        date,
        time,
        location: telemetry,
        photo: buildImageUrl(req, uploadedImageId),
        status: "COMPLETED",
      },
    });
  } catch (error) {
    console.error("Attendance Error:", error.message);
    // Rollback orphan image if DB write failed
    if (uploadedImageId) await deleteGridFSImage(uploadedImageId);
    res.status(500).json({
      error: "Database tracking pipeline failure.",
      details: error.message,
    });
  }
});

// ---------- GET Image ----------
app.get("/api/images/:id", async (req, res) => {
  try {
    if (!gridFSBucket)
      return res.status(503).json({ error: "Image storage is not ready." });

    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(400).json({ error: "Invalid image ID." });

    const fileId = new mongoose.Types.ObjectId(req.params.id);
    const file = await mongoose.connection.db
      .collection("attendanceImages.files")
      .findOne({ _id: fileId }, { projection: { contentType: 1, length: 1 } });

    if (!file) return res.status(404).json({ error: "Image not found." });

    res.set("Content-Type", file.contentType || "image/webp");
    res.set("Content-Length", file.length);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*"); // <img> CORS safety

    const stream = gridFSBucket.openDownloadStream(fileId);
    stream.on("error", (e) => {
      console.error("Image stream error:", e.message);
      if (!res.headersSent) res.status(404).json({ error: "Unable to retrieve image." });
    });
    stream.pipe(res);
  } catch (error) {
    console.error("Get Image Error:", error.message);
    if (!res.headersSent) res.status(400).json({ error: "Invalid image ID." });
  }
});

// ---------- GET Attendance (paginated) ----------
app.get("/api/attendance", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.username) filter.username = req.query.username.toUpperCase().trim();

    if (req.query.from || req.query.to) {
      const from = req.query.from ? new Date(req.query.from) : new Date("1970-01-01");
      const to = req.query.to ? new Date(req.query.to) : new Date();
      to.setHours(23, 59, 59, 999);
      if (isNaN(from) || isNaN(to))
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      filter.createdAt = { $gte: from, $lte: to };
    }

    const [records, total] = await Promise.all([
      Attendance.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Attendance.countDocuments(filter),
    ]);

    res.json({
      data: records.map((r) => ({
        ...r,
        photoIn: buildImageUrl(req, r.photoIn),
        photoOut: buildImageUrl(req, r.photoOut),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    console.error("Fetch Attendance Error:", error.message);
    res.status(500).json({ error: "Failed to access database logs." });
  }
});

// ---------- EXPORT CSV ----------
app.get("/api/attendance/export", async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = {};

    if (from || to) {
      const start = from ? new Date(from) : new Date("1970-01-01");
      const end = to ? new Date(to) : new Date();
      end.setHours(23, 59, 59, 999);
      if (isNaN(start) || isNaN(end))
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      if (start > end)
        return res.status(400).json({ error: "'from' date cannot be after 'to' date." });
      filter.createdAt = { $gte: start, $lte: end };
    }
    if (req.query.username)
      filter.username = req.query.username.toUpperCase().trim();

    const records = await Attendance.find(filter).sort({ createdAt: -1 }).lean();
    if (!records.length)
      return res.status(404).json({ error: "No records found for the selected range." });

    const headers = [
      "S.No", "Username", "Date", "Check-In", "Check-Out",
      "Location In", "Location Out", "Status",
      "Photo In URL", "Photo Out URL",
    ];

    const lines = [headers.join(",")];
    records.forEach((r, i) => {
      const row = [
        i + 1,
        r.username,
        r.date,
        r.timeIn || "-",
        r.timeOut || "-",
        r.locationIn || "-",
        r.locationOut || "-",
        r.status,
        buildImageUrl(req, r.photoIn),
        buildImageUrl(req, r.photoOut),
      ].map(csvEscape).join(",");
      lines.push(row);
    });

    const csv = "\uFEFF" + lines.join("\r\n");
    const fileName = `attendance_${from || "all"}_to_${to || "all"}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (error) {
    console.error("CSV Export Error:", error.message);
    res.status(500).json({ error: "Failed to generate CSV file." });
  }
});

// ---------- DELETE Attendance ----------
app.delete("/api/attendance/:id", async (req, res) => {
  try {
    const result = await Attendance.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: "Record not located." });

    await Promise.all([
      deleteGridFSImage(result.photoIn),
      deleteGridFSImage(result.photoOut),
    ]);

    res.json({ message: "Attendance record and associated images deleted successfully." });
  } catch (error) {
    console.error("Delete Error:", error.message);
    res.status(500).json({ error: "Failed to delete attendance record." });
  }
});

// ---------- Health ----------
app.get("/", (_req, res) => res.json({
  status: "OK",
  message: "Attendance API running with MongoDB GridFS.",
  uptime: process.uptime(),
}));

// ---------- Server ----------
app.listen(PORT, () => {
  console.log(`🚀 Server live on port ${PORT}`);
  console.log(`🌏 Timezone: ${TZ}`);
});