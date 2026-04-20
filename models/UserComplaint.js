import mongoose from "mongoose";

const userComplaintSchema = new mongoose.Schema(
  {
    complaintId: { type: String, unique: true },
    userId:      { type: String },
    userEmail:   { type: String },
    userName:    { type: String },
    against:     { type: String },
    againstType: {
      type: String,
      enum: ["soultee", "platform", "other"],
      default: "platform",
    },
    category: {
      type: String,
      enum: ["Behavior", "Service", "Technical", "Payment", "Content", "Other"],
      default: "Other",
    },
    description: { type: String, required: true },
    severity: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Pending", "Investigating", "Escalated", "Resolved"],
      default: "Pending",
    },
    resolution:  { type: String, default: null },
    handledBy:   { type: String, default: null },
    escalatedAt: { type: Date, default: null },
    resolvedAt:  { type: Date, default: null },
  },
  { timestamps: true }
);

userComplaintSchema.pre("save", async function (next) {
  if (!this.complaintId) {
    const count = await mongoose.model("UserComplaint").countDocuments();
    this.complaintId = `CMP-${String(count + 1).padStart(3, "0")}`;
  }
  next();
});

userComplaintSchema.index({ status: 1 });
userComplaintSchema.index({ severity: 1 });
userComplaintSchema.index({ category: 1 });
userComplaintSchema.index({ createdAt: -1 });

export default mongoose.model("UserComplaint", userComplaintSchema);
