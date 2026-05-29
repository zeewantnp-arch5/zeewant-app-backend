import mongoose from "mongoose";

const soulteeSchema = new mongoose.Schema({
  firebaseUid: { type: String, unique: true, sparse: true }, // Firebase Auth UID
  name: { type: String, required: true },
  category: String,
  gender: String,
  specialization: String,
  experienceYears: Number,
  languages: [String],
  rating: { type: Number, default: 0 },
  totalFeedbacks: { type: Number, default: 0 },
  status: { type: String, default: "offline" }, // online | offline | busy
  feePerSession: { type: Number, default: 0 },   // dynamic fee in NPR
  currency: { type: String, default: "NPR" },
  durationMinutes: Number,
  bio: String,
  profileImage: String,
}, { timestamps: true });

export default mongoose.model("Soultee", soulteeSchema);