import mongoose from "mongoose";

const emotionalPrescriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: String, // Firebase UID
      required: true,
      index: true,
    },

    // ── Input ──────────────────────────────────────────────────────────────────
    input: {
      age: Number,
      educationLevel: String,
      emotionalState: String,
      problem: String,
      currentSituation: String,
      stabilityScore: { type: Number, default: 0 },
    },

    // ── Parsed output ──────────────────────────────────────────────────────────
    emotionalDiagnosis: String,
    rootCause: String,
    dailyRx: String,
    weeklyRx: String,
    emergencyRx: String,
    whatToAvoid: String,
    mindsetShift: String,
    supportSuggestion: String,
    closingNote: String,

    // Raw response from Claude
    rawText: String,
  },
  { timestamps: true }
);

export default mongoose.model("EmotionalPrescription", emotionalPrescriptionSchema);
