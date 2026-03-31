import express from "express";
import jwt from "jsonwebtoken";
import Souljar from "../models/souljar.js";
import Soultee from "../models/Soultee.js";

const router = express.Router();

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

// ─── POST /api/admin/login ────────────────────────────────────────────────────
router.post("/login", (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = jwt.sign(
    { username },
    process.env.JWT_SECRET || "fallback_secret",
    { expiresIn: "12h" }
  );

  res.json({ token, message: "Login successful" });
});

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const [totalEntries, totalSoultees, moodPipeline, topicPipeline, recentEntries] =
      await Promise.all([
        Souljar.countDocuments(),
        Soultee.countDocuments(),
        Souljar.aggregate([
          { $group: { _id: "$mood", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Souljar.aggregate([
          { $group: { _id: "$topic", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        Souljar.find().sort({ createdAt: -1 }).limit(5).select("userId mood topic stamp createdAt"),
      ]);

    const totalWords = await Souljar.aggregate([
      { $group: { _id: null, total: { $sum: "$wordCount" } } },
    ]);

    res.json({
      totalEntries,
      totalSoultees,
      totalWords: totalWords[0]?.total || 0,
      moodDistribution: Object.fromEntries(moodPipeline.map((m) => [m._id || "None", m.count])),
      topicDistribution: Object.fromEntries(topicPipeline.map((t) => [t._id || "None", t.count])),
      recentEntries,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GET /api/admin/souljar ───────────────────────────────────────────────────
// Query: page, limit, search, mood, topic, userId
router.get("/souljar", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.mood) filter.mood = req.query.mood;
    if (req.query.topic) filter.topic = req.query.topic;
    if (req.query.userId) filter.userId = req.query.userId;
    if (req.query.search) {
      filter.$or = [
        { text: { $regex: req.query.search, $options: "i" } },
        { jarCode: { $regex: req.query.search, $options: "i" } },
        { ocrText: { $regex: req.query.search, $options: "i" } },
      ];
    }

    const [entries, total] = await Promise.all([
      Souljar.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Souljar.countDocuments(filter),
    ]);

    res.json({
      entries,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DELETE /api/admin/souljar/:id ───────────────────────────────────────────
router.delete("/souljar/:id", requireAdmin, async (req, res) => {
  try {
    await Souljar.findByIdAndDelete(req.params.id);
    res.json({ message: "Entry deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GET /api/admin/soultees ──────────────────────────────────────────────────
router.get("/soultees", requireAdmin, async (req, res) => {
  try {
    const soultees = await Soultee.find().sort({ createdAt: -1 }).lean();
    res.json({ soultees, total: soultees.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
