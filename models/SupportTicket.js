import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sender:    { type: String, required: true }, // "user" | "admin"
    senderId:  { type: String },
    senderName:{ type: String },
    content:   { type: String, required: true },
    sentAt:    { type: Date, default: Date.now },
  },
  { _id: false }
);

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId:   { type: String, unique: true },
    userId:     { type: String },
    userEmail:  { type: String },
    userName:   { type: String },
    subject:    { type: String, required: true },
    description:{ type: String, required: true },
    category:   {
      type: String,
      enum: ["Technical", "Payment", "Session", "Account", "Content", "Other"],
      default: "Other",
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Open", "In Progress", "Resolved", "Closed"],
      default: "Open",
    },
    assignedTo:  { type: String, default: null },
    messages:    { type: [messageSchema], default: [] },
    resolvedAt:  { type: Date, default: null },
    tags:        { type: [String], default: [] },
  },
  { timestamps: true }
);

// Auto-generate ticketId before save
supportTicketSchema.pre("save", async function (next) {
  if (!this.ticketId) {
    const count = await mongoose.model("SupportTicket").countDocuments();
    this.ticketId = `TKT-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

supportTicketSchema.index({ status: 1 });
supportTicketSchema.index({ priority: 1 });
supportTicketSchema.index({ category: 1 });
supportTicketSchema.index({ createdAt: -1 });
supportTicketSchema.index({ userId: 1 });

export default mongoose.model("SupportTicket", supportTicketSchema);
