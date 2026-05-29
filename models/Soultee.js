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
  feePerSession: { type: Number, default: 0 },
  currency: { type: String, default: "NPR" },
  durationMinutes: Number,
  bio: String,
  profileImage: String,
  // ── Payment details ─────────────────────────────────────────────────────────
  bankAccount: {
    bankName:      { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    accountHolder: { type: String, default: "" },
    branchName:    { type: String, default: "" },
    updatedAt:     { type: Date,   default: null },
  },
  esewaNumber: { type: String, default: "" },  // soultee's eSewa ID/number
  esewaQrUrl:  { type: String, default: "" },  // QR image uploaded by soultee
  khaltiNumber: { type: String, default: "" }, // soultee's Khalti ID/number
  khaltiQrUrl:  { type: String, default: "" }, // QR image uploaded by soultee
}, { timestamps: true });

export default mongoose.model("Soultee", soulteeSchema);