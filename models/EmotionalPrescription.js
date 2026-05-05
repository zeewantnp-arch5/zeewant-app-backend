import mongoose from "mongoose";

const emotionalPrescriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    studentName: { type: String, default: "" },
    soulteeUid: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
      index: true,
    },

    // ── Input (from student) ───────────────────────────────────────────────────
    input: {
      age: Number,
      educationLevel: String,
      emotionalState: String,
      problem: String,
      currentSituation: String,
      stabilityScore: { type: Number, default: 0 },
    },

    // ── Prescription (filled by soultee) ──────────────────────────────────────
    emotionalDiagnosis: String,
    rootCause: String,
    dailyRx: String,
    weeklyRx: String,
    emergencyRx: String,
    whatToAvoid: String,
    mindsetShift: String,
    supportSuggestion: String,
    closingNote: String,
    rawText: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("EmotionalPrescription", emotionalPrescriptionSchema);
