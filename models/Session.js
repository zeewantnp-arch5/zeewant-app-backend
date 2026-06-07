import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    soulteeFirebaseUid: { type: String, required: true },
    studentFirebaseUid: { type: String, required: true },
    studentName: { type: String, default: "Student" },

    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 60 },
    sessionFee: { type: Number, default: 0 },

    // upcoming | ongoing | completed | cancelled
    status: {
      type: String,
      enum: ["upcoming", "ongoing", "completed", "cancelled"],
      default: "upcoming",
    },

    notes:        { type: String, default: "" },
    sessionType:  { type: String, default: "chat" }, // chat | video | voice
    cancelReason: { type: String, default: "" },

    // Timer tracking — set when status transitions to "ongoing"
    startedAt: { type: Date, default: null },

    // Earnings split — set when session completes
    commissionRate:  { type: Number, default: 20 },   // platform % (e.g. 20)
    soulteeEarnings: { type: Number, default: null },  // sessionFee * (1 - rate/100)
    platformEarnings:{ type: Number, default: null },

    // Admin payment — true only after admin explicitly pays the soultee their share
    adminPaid:   { type: Boolean, default: false },
    adminPaidAt: { type: Date,    default: null  },
  },
  { timestamps: true }
);

sessionSchema.index({ soulteeFirebaseUid: 1, status: 1, scheduledAt: -1 });
sessionSchema.index({ studentFirebaseUid: 1, status: 1, scheduledAt: -1 });

export default mongoose.model("Session", sessionSchema);
