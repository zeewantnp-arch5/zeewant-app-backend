import express from "express";
import jwt from "jsonwebtoken";
import Souljar from "../models/souljar.js";
import Soultee from "../models/Soultee.js";
import admin from "../config/firebase.js";

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
  const { username, password, idToken } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";

  const createAdminToken = (payloadUsername, extra = {}) =>
    jwt.sign(
      { username: payloadUsername, ...extra },
      process.env.JWT_SECRET || "fallback_secret",
      { expiresIn: "12h" }
    );

  // Firebase-auth flow (email/password done on client, ID token verified here)
  if (idToken) {
    if (!admin.apps.length) {
      return res.status(500).json({ message: "Firebase Admin not initialised" });
    }

    admin
      .auth()
      .verifyIdToken(idToken)
      .then((decoded) => {
        const email = String(decoded.email || "").toLowerCase();
        const allowed = String(process.env.ADMIN_ALLOWED_EMAILS || "")
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean);

        const hasAdminClaim = decoded.admin === true || decoded.superAdmin === true;
        const isAllowedEmail = email && allowed.includes(email);

        if (!hasAdminClaim && !isAllowedEmail) {
          return res.status(403).json({ message: "Not authorized for admin panel" });
        }

        const token = createAdminToken(email || username || "admin", {
          firebaseUid: decoded.uid,
          email: decoded.email || null,
          authType: "firebase",
        });

        return res.json({ token, message: "Login successful" });
      })
      .catch(() => {
        return res.status(401).json({ message: "Invalid Firebase token" });
      });
    return;
  }

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = createAdminToken(username, { authType: "env" });

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

// ─── Firestore helper ─────────────────────────────────────────────────────────
function getFirestore() {
  if (!admin.apps.length) throw new Error("Firebase Admin not initialised");
  return admin.firestore();
}

// ─── GET /api/admin/soultees/firebase-all ─────────────────────────────────────
// Fetch approved (role=='soultee') + pending (rolePending==true) from Firestore
router.get("/soultees/firebase-all", requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const usersCol = db.collection("users");

    const [approvedSnap, pendingSnap] = await Promise.all([
      usersCol.where("role", "==", "soultee").get(),
      usersCol.where("rolePending", "==", true).get(),
    ]);

    const profiles = {};

    approvedSnap.forEach((doc) => {
      profiles[doc.id] = { uid: doc.id, ...doc.data() };
    });

    pendingSnap.forEach((doc) => {
      if (!profiles[doc.id]) {
        profiles[doc.id] = { uid: doc.id, ...doc.data() };
      }
    });

    const list = Object.values(profiles).sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );

    res.json({ soultees: list, total: list.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/approve ───────────────────────────────────
router.patch("/soultees/:uid/approve", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { soulteeType } = req.body;

  try {
    const db = getFirestore();

    // 1. Update Firestore user document
    await db.collection("users").doc(uid).update({
      role: "soultee",
      rolePending: false,
      soulteeType: soulteeType || "General",
      soulteeStatus: "Active",
    });

    // 2. Fetch the latest profile data to upsert into MongoDB
    const userDoc = await db.collection("users").doc(uid).get();
    const data = userDoc.data() || {};

    await Soultee.findOneAndUpdate(
      { firebaseUid: uid },
      {
        firebaseUid: uid,
        name: data.name || "Unknown",
        gender: data.gender || "",
        specialization: Array.isArray(data.specialization)
          ? data.specialization.join(", ")
          : data.specialization || "",
        languages: data.languages || [],
        feePerSession: data.fees || 0,
        bio: data.bio || "",
        profileImage: data.profileImageUrl || "",
        status: "offline",
      },
      { upsert: true, new: true }
    );

    res.json({ message: "SOULTEE approved successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/reject ────────────────────────────────────
router.patch("/soultees/:uid/reject", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const db = getFirestore();
    await db.collection("users").doc(uid).update({
      role: "Student",
      rolePending: false,
    });
    res.json({ message: "SOULTEE rejected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/suspend ───────────────────────────────────
router.patch("/soultees/:uid/suspend", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const db = getFirestore();
    await db.collection("users").doc(uid).update({ soulteeStatus: "Suspended" });

    // Also mark offline in MongoDB
    await Soultee.findOneAndUpdate({ firebaseUid: uid }, { status: "offline" });

    res.json({ message: "SOULTEE suspended" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/reactivate ────────────────────────────────
router.patch("/soultees/:uid/reactivate", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  try {
    const db = getFirestore();
    await db.collection("users").doc(uid).update({ soulteeStatus: "Active" });
    res.json({ message: "SOULTEE reactivated" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/badge ────────────────────────────────────
router.patch("/soultees/:uid/badge", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { badge } = req.body;
  if (!["Gold", "Silver", "Diamond"].includes(badge)) {
    return res.status(400).json({ message: "Invalid badge value" });
  }
  try {
    const db = getFirestore();
    await db.collection("users").doc(uid).update({ badge });
    res.json({ message: `Badge set to ${badge}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PATCH /api/admin/soultees/:uid/type ─────────────────────────────────────
router.patch("/soultees/:uid/type", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const { soulteeType } = req.body;
  try {
    const db = getFirestore();
    await db.collection("users").doc(uid).update({ soulteeType });
    res.json({ message: `Type updated to ${soulteeType}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
