import mongoose from "mongoose";

const soulteeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  gender: String,
  specialization: String,
  experienceYears: Number,
  languages: [String],
  rating: { type: Number, default: 0 },
  totalFeedbacks: { type: Number, default: 0 },
  status: { type: String, default: "offline" },
  feePerSession: Number,
  durationMinutes: Number,
}, { timestamps: true });

export default mongoose.model("Soultee", soulteeSchema);