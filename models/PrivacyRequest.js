import mongoose from "mongoose";

const privacyRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, unique: true, index: true },

    // Submitted by (Firebase UID)
    userId:      { type: String, required: true, index: true },
    userEmail:   { type: String, default: "" },
    displayName: { type: String, default: "User" },

    type: {
      type: String,
      enum: ["data_export", "account_deletion", "consent_update"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "rejected"],
      default: "pending",
      index: true,
    },

    notes:           { type: String, default: "" },
    processedBy:     { type: String, default: null },
    processedByName: { type: String, default: null },
    processedAt:     { type: Date,   default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Auto-generate sequential PRV-XXXX ID before first save
privacyRequestSchema.pre("save", async function (next) {
  if (this.requestId) return next();
  try {
    const count = await this.constructor.countDocuments();
    this.requestId = `PRV-${String(count + 201).padStart(3, "0")}`;
  } catch {
    this.requestId = `PRV-${Date.now()}`;
  }
  next();
});

// Virtual: due date = 14 days from submission
privacyRequestSchema.virtual("dueDate").get(function () {
  if (!this.createdAt) return null;
  const d = new Date(this.createdAt);
  d.setDate(d.getDate() + 14);
  return d;
});

privacyRequestSchema.index({ status: 1, createdAt: -1 });
privacyRequestSchema.index({ type: 1,   createdAt: -1 });

export default mongoose.model("PrivacyRequest", privacyRequestSchema);
