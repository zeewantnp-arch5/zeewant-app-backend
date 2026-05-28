import mongoose from "mongoose";

const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      enum: ["normal", "pro", "advanced"],
    },
    displayName: { type: String, required: true },
    price: { type: Number, required: true }, // NPR
    durationDays: { type: Number, default: 30 },
    features: [{ type: String }],
    isPopular: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Seed default plans if none exist
subscriptionPlanSchema.statics.ensureDefaults = async function () {
  const count = await this.countDocuments();
  if (count > 0) return;

  await this.insertMany([
    {
      name: "normal",
      displayName: "Normal Plan",
      price: 250,
      durationDays: 30,
      isPopular: false,
      features: [
        "Basic chat access",
        "Connect with Soultees",
        "Session messaging",
        "Standard support",
      ],
    },
    {
      name: "pro",
      displayName: "Pro Plan",
      price: 300,
      durationDays: 30,
      isPopular: true,
      features: [
        "Priority chat access",
        "Connect with Soultees",
        "Faster response times",
        "File & media sharing",
        "Better experience",
      ],
    },
    {
      name: "advanced",
      displayName: "Advanced Plan",
      price: 500,
      durationDays: 30,
      isPopular: false,
      features: [
        "Full premium access",
        "All advanced chat features",
        "Unlimited sessions",
        "Priority Soultee matching",
        "AI-powered insights",
        "24/7 premium support",
      ],
    },
  ]);
};

export default mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
