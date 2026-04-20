import mongoose from "mongoose";

const userFeedbackSchema = new mongoose.Schema(
  {
    userId:      { type: String },
    userEmail:   { type: String },
    userName:    { type: String },
    sessionId:   { type: String, default: null },
    soulteeId:   { type: String, default: null },
    rating:      { type: Number, required: true, min: 1, max: 5 },
    comment:     { type: String, default: "" },
    type: {
      type: String,
      enum: ["session", "app", "content", "general", "survey"],
      default: "general",
    },
    surveyTitle: { type: String, default: null },
    tags:        { type: [String], default: [] },
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative"],
    },
    source: { type: String, default: "app" },
  },
  { timestamps: true }
);

// Auto-compute sentiment from rating
userFeedbackSchema.pre("save", function (next) {
  if (this.rating >= 4) this.sentiment = "positive";
  else if (this.rating === 3) this.sentiment = "neutral";
  else this.sentiment = "negative";
  next();
});

userFeedbackSchema.index({ type: 1 });
userFeedbackSchema.index({ sentiment: 1 });
userFeedbackSchema.index({ rating: 1 });
userFeedbackSchema.index({ createdAt: -1 });

export default mongoose.model("UserFeedback", userFeedbackSchema);
