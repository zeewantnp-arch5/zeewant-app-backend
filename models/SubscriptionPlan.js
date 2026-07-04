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

// Upsert default plans — always runs so price/feature changes take effect on restart.
subscriptionPlanSchema.statics.ensureDefaults = async function () {
  const defaults = [
    {
      name: "normal",
      displayName: "Normal",
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
      displayName: "Pro",
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
      displayName: "Advanced",
      price: 500,
      durationDays: 30,
      isPopular: false,
      features: [
        "Full premium access",
        "All advanced chat features",
        "Unlimited sessions",
        "Priority Soultee matching",
        "Smart insights",
        "24/7 premium support",
      ],
    },
  ];

  await Promise.all(
    defaults.map((plan) =>
      this.updateOne(
        { name: plan.name },
        { $set: plan },
        { upsert: true }
      )
    )
  );
};

export default mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
