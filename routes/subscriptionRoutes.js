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

// ─── GET /api/subscriptions/status/:userId?soulteeId=<uid> ───────────────────
// Returns active subscription for a specific student-soultee pair, or null.
// soulteeId is required — subscription is per pair, not global.
router.get("/status/:userId", async (req, res) => {
  try {
    const { soulteeId } = req.query;
    if (!soulteeId) {
      return res.status(400).json({ message: "soulteeId query parameter is required" });
    }

    const now = new Date();
    const subscription = await UserSubscription.findOne({
      userId: req.params.userId,
      soulteeId,
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

// ─── GET /api/subscriptions/active-soultees/:userId ──────────────────────────
// Returns list of soulteeIds that the student has an active subscription for.
router.get("/active-soultees/:userId", async (req, res) => {
  try {
    const now = new Date();
    const subs = await UserSubscription.find({
      userId: req.params.userId,
      status: "active",
      expiryDate: { $gt: now },
    }).select("soulteeId").lean();
    res.json({ soulteeIds: subs.map(s => s.soulteeId).filter(Boolean) });
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
