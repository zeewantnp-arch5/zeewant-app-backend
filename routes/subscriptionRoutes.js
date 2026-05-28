import express from "express";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import UserSubscription from "../models/UserSubscription.js";

const router = express.Router();

// ─── GET /api/subscriptions/plans ────────────────────────────────────────────
// Returns all active subscription plans
router.get("/plans", async (_req, res) => {
  try {
    const plans = await SubscriptionPlan.find({ isActive: true }).lean();
    res.json({ plans });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/subscriptions/status/:userId ────────────────────────────────────
// Returns active subscription for a user, or null if none
router.get("/status/:userId", async (req, res) => {
  try {
    const now = new Date();
    const subscription = await UserSubscription.findOne({
      userId: req.params.userId,
      status: "active",
      expiryDate: { $gt: now },
    })
      .populate("planId", "displayName features price isPopular")
      .lean();

    res.json({ subscription: subscription || null, hasActive: !!subscription });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/subscriptions/history/:userId ───────────────────────────────────
// Returns full subscription history for a user
router.get("/history/:userId", async (req, res) => {
  try {
    const subscriptions = await UserSubscription.find({
      userId: req.params.userId,
    })
      .sort({ createdAt: -1 })
      .populate("planId", "displayName price")
      .lean();

    res.json({ subscriptions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
