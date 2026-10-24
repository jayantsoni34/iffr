const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allows large base64 data strings

// 1. Cloudinary Configuration
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 2. MongoDB Configuration & Schema
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27012/selfie_tracker')
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('MongoDB Connection Error:', err));

const CheckInSchema = new mongoose.Schema({
  imageUrl: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  location: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true }
  }
});

const CheckIn = mongoose.model('CheckIn', CheckInSchema);

// 3. API Endpoints
// Post check-in data (Selfie Base64 + Location Data)
app.post('/api/checkin', async (req, res) => {
  try {
    const { imageBase64, latitude, longitude } = req.body;

    if (!imageBase64 || !latitude || !longitude) {
      return res.status(400).json({ error: 'Missing required data fields' });
    }

    // Upload base64 image string directly to Cloudinary
    const uploadResponse = await cloudinary.uploader.upload(imageBase64, {
      folder: 'selfie_checkins',
    });

    // Save metadata record into MongoDB
    const newCheckIn = new CheckIn({
      imageUrl: uploadResponse.secure_url,
      location: { latitude, longitude }
    });

    await newCheckIn.save();
    res.status(201).json({ message: 'Check-in saved successfully!', data: newCheckIn });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server configuration or upload failed' });
  }
});

// Get all historical check-in records
app.get('/api/checkins', async (req, res) => {
  try {
    const records = await CheckIn.find().sort({ timestamp: -1 });
    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch check-in history' });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running smoothly on port ${PORT}`));
