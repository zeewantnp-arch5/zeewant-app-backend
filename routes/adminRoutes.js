import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import Souljar from "../models/souljar.js";
import Soultee from "../models/Soultee.js";
import Soulpana from "../models/Soulpana.js";
import Session from "../models/Session.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import AdminUser, { ADMIN_ROLES } from "../models/AdminUser.js";
import SoulteeApplication, { computeCompletenessScore, computeRiskFlags } from "../models/SoulteeApplication.js";
import AuditLog from "../models/AuditLog.js";
import SystemSettings from "../models/SystemSettings.js";
import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";
import admin, { syncNotificationToRTDB, sendPushNotification } from "../config/firebase.js";
import { sendResetCodeEmail } from "../services/emailService.js";

// Multer: store in memory so we can stream to Firebase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

/** Role guard — pass one or more roles that are allowed. */
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.admin?.role)) {
    return res.status(403).json({ message: "Insufficient permissions" });
  }
  next();
};

// ─── POST /api/admin/login ────────────────────────────────────────────────────
// Flow: look up AdminUser in MongoDB → verify bcrypt → return JWT with role.
// Falls back to env-based single admin for first-run / backwards-compat.
router.post("/login", async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  try {
    // 1. Look up by username OR email in MongoDB
    //    If role is provided, also filter by role so wrong-role attempts fail early.
    const query = {
      $or: [
        { username: username.trim() },
        { email: username.trim().toLowerCase() },
      ],
      isActive: true,
    };
    if (role) query.role = role;

    const adminUser = await AdminUser.findOne(query);

    if (!adminUser) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Verify bcrypt password
    const valid = await adminUser.verifyPassword(password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: adminUser._id.toString(),
        username: adminUser.username,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
      },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    // Resolve profile photo:
    // 1. Use custom uploaded photo (profileImage in MongoDB)
    // 2. Fetch from Firebase Auth (Google/Gmail photo) and persist it
    let photoUrl = adminUser.profileImage || null;
    if (!photoUrl && admin.apps.length) {
      try {
        const fbUser = await admin.auth().getUserByEmail(adminUser.email);
        if (fbUser.photoURL) {
          photoUrl = fbUser.photoURL;
          // Persist so future sessions load instantly without Firebase lookup
          await AdminUser.findByIdAndUpdate(adminUser._id, { profileImage: fbUser.photoURL });
          console.log(`[Admin] Saved Gmail photo for ${adminUser.email}`);
        }
      } catch (e) {
        // Not in Firebase Auth — no Google photo available
        console.log(`[Admin] No Firebase Auth user for ${adminUser.email}: ${e.message}`);
      }
    }

    // Log login action
    try {
      await AuditLog.create({
        adminId:    adminUser._id.toString(),
        adminName:  adminUser.name,
        adminRole:  adminUser.role,
        action:     "login",
        resourceType: "admin",
        description: `Admin logged in: ${adminUser.email}`,
        severity:   "info",
        ipAddress:  req.ip || req.headers["x-forwarded-for"] || "",
        userAgent:  req.headers["user-agent"] || "",
      });
    } catch (_) { /* non-fatal */ }

    return res.json({
      token,
      name: adminUser.name,
      email: adminUser.email,
      role: adminUser.role,
      photoUrl,
      message: "Login successful",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── POST /api/admin/seed ─────────────────────────────────────────────────────
// One-time: create an admin account via header-based secret (scripts/createAdmin.js).
router.post("/seed", async (req, res) => {
  const secret = req.headers["x-setup-secret"];
  if (!secret || secret !== process.env.ADMIN_SETUP_SECRET) {
    return res.status(403).json({ message: "Forbidden — set ADMIN_SETUP_SECRET in .env" });
  }

  const { username, email, password, name, role } = req.body;

  if (!username || !email || !password || !name || !role) {
    return res.status(400).json({
      message: "All fields required: username, email, password, name, role",
      validRoles: ADMIN_ROLES,
    });
  }

  if (!ADMIN_ROLES.includes(role)) {
    return res.status(400).json({ message: `role must be one of: ${ADMIN_ROLES.join(", ")}` });
  }

  try {
    const existing = await AdminUser.findOne({
      $or: [{ username }, { email: email.toLowerCase() }],
    });
    if (existing) {
      return res.status(409).json({ message: "Username or email already exists" });
    }

    const newAdmin = new AdminUser({ username, email, name, role });
    await newAdmin.setPassword(password);
    await newAdmin.save();

    res.status(201).json({
      message: "Admin created",
      admin: { username: newAdmin.username, email: newAdmin.email, role: newAdmin.role, name: newAdmin.name },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── POST /api/admin/register ─────────────────────────────────────────────────
// Self-registration from the admin panel UI.
// Requires setupKey in the body matching ADMIN_SETUP_SECRET.
router.post("/register", async (req, res) => {
  const { name, email, password, role, setupKey } = req.body;

  if (!name || !email || !password || !role || !setupKey) {
    return res.status(400).json({ message: "All fields are required" });
  }

  if (setupKey !== process.env.ADMIN_SETUP_SECRET) {
    return res.status(403).json({ message: "Invalid setup key" });
  }

  if (!ADMIN_ROLES.includes(role)) {
    return res.status(400).json({ message: `Invalid role` });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  try {
    const existing = await AdminUser.findOne({ email: email.trim().toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: "An account with this email already exists" });
    }

    const newAdmin = new AdminUser({
      username: email.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      name: name.trim(),
      role,
    });
    await newAdmin.setPassword(password);
    await newAdmin.save();

    // Auto-login: issue JWT immediately
    const token = jwt.sign(
      {
        id: newAdmin._id.toString(),
        username: newAdmin.username,
        name: newAdmin.name,
        email: newAdmin.email,
        role: newAdmin.role,
      },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.status(201).json({
      token,
      name: newAdmin.name,
      email: newAdmin.email,
      role: newAdmin.role,
      message: "Account created successfully",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── POST /api/admin/forgot-password ─────────────────────────────────────────
// Generates a 6-digit OTP, saves it, and emails it to the admin's Gmail.
// The code is NOT returned in the response to prevent enumeration.
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  try {
    const adminUser = await AdminUser.findOne({
      email: email.trim().toLowerCase(),
      isActive: true,
    });

    // Always return 200 to avoid email enumeration
    if (!adminUser) {
      return res.json({
        message: "If that email is registered, a reset code has been sent to it.",
      });
    }

    // Generate a 6-digit OTP, valid for 15 minutes
    const code = String(Math.floor(100000 + Math.random() * 900000));
    adminUser.resetToken = code;
    adminUser.resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await adminUser.save();

    // Send OTP to the admin's Gmail inbox
    await sendResetCodeEmail(adminUser.email, code);
    console.log(`[Admin Reset] OTP sent to ${adminUser.email}`);

    res.json({
      message: "A 6-digit reset code has been sent to your email. Check your inbox.",
    });
  } catch (error) {
    console.error("[Admin Reset] Error:", error.message);
    // Surface email config errors clearly; hide other internals
    const isMailError = error.message.includes("MAIL_USER") ||
                        error.message.includes("MAIL_PASS") ||
                        error.message.includes("Email not configured");
    res.status(500).json({
      message: isMailError
        ? "Email service not configured. Contact your system administrator."
        : "Failed to send reset code. Please try again.",
    });
  }
});

// ─── POST /api/admin/reset-password ──────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { email, resetCode, newPassword } = req.body;

  if (!email || !resetCode || !newPassword) {
    return res.status(400).json({ message: "email, resetCode, and newPassword are required" });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  try {
    const adminUser = await AdminUser.findOne({
      email: email.trim().toLowerCase(),
      resetToken: resetCode.trim(),
      isActive: true,
    });

    if (!adminUser) {
      return res.status(400).json({ message: "Invalid or expired reset code" });
    }

    if (!adminUser.resetTokenExpiry || adminUser.resetTokenExpiry < new Date()) {
      return res.status(400).json({ message: "Reset code has expired. Please request a new one." });
    }

    await adminUser.setPassword(newPassword);
    adminUser.resetToken = null;
    adminUser.resetTokenExpiry = null;
    await adminUser.save();

    res.json({ message: "Password reset successfully. You can now sign in." });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GET /api/admin/me ────────────────────────────────────────────────────────
// Returns the current admin's profile from the JWT payload.
router.get("/me", requireAdmin, (req, res) => {
  res.json({
    id: req.admin.id,
    username: req.admin.username,
    name: req.admin.name,
    email: req.admin.email,
    role: req.admin.role,
  });
});

// ─── POST /api/admin/profile/avatar ──────────────────────────────────────────
// Upload admin profile picture to Firebase Storage, save URL in MongoDB.
router.post(
  "/profile/avatar",
  requireAdmin,
  upload.single("avatar"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No image file provided" });
    }

    try {
      if (!admin.apps.length) {
        return res.status(500).json({ message: "Firebase not initialised" });
      }

      const bucket = admin.storage().bucket();
      const ext = req.file.mimetype === "image/png" ? "png" : "jpg";
      const destPath = `admin-avatars/${req.admin.id}.${ext}`;
      const fileRef = bucket.file(destPath);

      // Upload buffer to Firebase Storage
      await fileRef.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
      });

      // Get a long-lived signed URL (10 years) — works on all bucket types
      // including uniform-access-control buckets where makePublic() fails
      const [imageUrl] = await fileRef.getSignedUrl({
        action: "read",
        expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      });

      // Save URL in MongoDB (overrides Gmail photo going forward)
      await AdminUser.findByIdAndUpdate(req.admin.id, { profileImage: imageUrl });

      res.json({ imageUrl, photoUrl: imageUrl, message: "Avatar updated" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const [totalEntries, totalSoultees, moodPipeline, topicPipeline, recentEntries] =
      await Promise.all([
        Souljar.countDocuments(),
        Soultee.countDocuments(),
        Souljar.aggregate([{ $group: { _id: "$mood", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
        Souljar.aggregate([{ $group: { _id: "$topic", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
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
      Souljar.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Souljar.countDocuments(filter),
    ]);

    res.json({ entries, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DELETE /api/admin/souljar/:id ───────────────────────────────────────────
router.delete("/souljar/:id", requireAdmin, requireRole("superAdmin"), async (req, res) => {
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

async function clearSoulteeState(db, uid) {
  await db.collection("users").doc(uid).set(
    {
      role: "student",
      rolePending: false,
      soulteeType: admin.firestore.FieldValue.delete(),
      soulteeStatus: admin.firestore.FieldValue.delete(),
      badge: admin.firestore.FieldValue.delete(),
      profileSubmittedAt: admin.firestore.FieldValue.delete(),
      updatedAt: new Date(),
    },
    { merge: true }
  );

  await Soultee.findOneAndDelete({ firebaseUid: uid });
}

// ─── GET /api/admin/soultees/firebase-all ─────────────────────────────────────
router.get("/soultees/firebase-all", requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const usersCol = db.collection("users");

    const [approvedSnap, pendingSnap] = await Promise.all([
      usersCol.where("role", "==", "soultee").get(),
      usersCol.where("rolePending", "==", true).get(),
    ]);

    const profiles = {};
    approvedSnap.forEach((doc) => { profiles[doc.id] = { uid: doc.id, ...doc.data() }; });
    pendingSnap.forEach((doc) => {
      if (!profiles[doc.id]) profiles[doc.id] = { uid: doc.id, ...doc.data() };
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
router.patch(
  "/soultees/:uid/approve",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    const { soulteeType } = req.body;
    try {
      const db = getFirestore();
      await db.collection("users").doc(uid).update({
        role: "soultee",
        rolePending: false,
        soulteeType: soulteeType || "General",
        soulteeStatus: "Active",
      });

      const userDoc = await db.collection("users").doc(uid).get();
      const data = userDoc.data() || {};

      await Soultee.findOneAndUpdate(
        { firebaseUid: uid },
        {
          firebaseUid: uid,
          name: data.name || "Unknown",
          category: soulteeType || data.soulteeType || "General",
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
  }
);

// ─── PATCH /api/admin/soultees/:uid/reject ────────────────────────────────────
router.patch(
  "/soultees/:uid/reject",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    try {
      const db = getFirestore();
      await db.collection("users").doc(uid).update({ role: "Student", rolePending: false });
      res.json({ message: "SOULTEE rejected" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

// ─── PATCH /api/admin/soultees/:uid/suspend ───────────────────────────────────
router.patch(
  "/soultees/:uid/suspend",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    try {
      const db = getFirestore();
      await db.collection("users").doc(uid).update({ soulteeStatus: "Suspended" });
      await Soultee.findOneAndUpdate({ firebaseUid: uid }, { status: "offline" });
      res.json({ message: "SOULTEE suspended" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

// ─── PATCH /api/admin/soultees/:uid/reactivate ────────────────────────────────
router.patch(
  "/soultees/:uid/reactivate",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    try {
      const db = getFirestore();
      await db.collection("users").doc(uid).update({ soulteeStatus: "Active" });
      res.json({ message: "SOULTEE reactivated" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

// ─── PATCH /api/admin/soultees/:uid/badge ────────────────────────────────────
router.patch(
  "/soultees/:uid/badge",
  requireAdmin,
  requireRole("superAdmin", "analyticsAdmin"),
  async (req, res) => {
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
  }
);

// ─── PATCH /api/admin/soultees/:uid/type ─────────────────────────────────────
router.patch(
  "/soultees/:uid/type",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    const { soulteeType } = req.body;
    try {
      const db = getFirestore();
      await db.collection("users").doc(uid).update({ soulteeType });
      res.json({ message: `Type updated to ${soulteeType}` });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);

router.delete(
  "/soultees/:uid",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { uid } = req.params;
    try {
      const db = getFirestore();
      await clearSoulteeState(db, uid);
      await SoulteeApplication.deleteMany({ firebaseUid: uid });
      res.json({ message: "SOULTEE profile deleted" });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  }
);


// ════════════════════════════════════════════════════════════════════════════
//  AUDIT LOG HELPER — call from any route handler
// ════════════════════════════════════════════════════════════════════════════

async function writeAuditLog(req, { action, resourceType, resourceId, resourceName, description, severity = "info", metadata = {} }) {
  try {
    await AuditLog.create({
      adminId:      req.admin.id,
      adminName:    req.admin.name,
      adminRole:    req.admin.role,
      action,
      resourceType,
      resourceId,
      resourceName,
      description,
      severity,
      metadata,
      ipAddress: req.ip || req.headers["x-forwarded-for"] || "",
      userAgent: req.headers["user-agent"] || "",
    });
  } catch (e) {
    console.error("[AuditLog] Write failed:", e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  LIVE DASHBOARD STATS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/dashboard/stats
router.get("/dashboard/stats", requireAdmin, async (req, res) => {
  try {
    const now        = new Date();
    const dayAgo     = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo    = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalSoultees,
      activeSoultees,
      totalSessions,
      completedSessions,
      totalLinks,
      activeLinks,
      pendingApplications,
      approvedThisMonth,
      rejectedApplications,
      totalSoulpana,
      pendingSoulpana,
      answeredSoulpana,
      totalSouljar,
      recentLogins,
      totalAdmins,
    ] = await Promise.all([
      Soultee.countDocuments(),
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
      Session.countDocuments(),
      Session.countDocuments({ status: "completed" }),
      StudentSoulteeLink.countDocuments(),
      StudentSoulteeLink.countDocuments({ status: "active" }),
      SoulteeApplication.countDocuments({ status: "pending" }),
      SoulteeApplication.countDocuments({ status: "approved", reviewedAt: { $gte: monthStart } }),
      SoulteeApplication.countDocuments({ status: "rejected" }),
      Soulpana.countDocuments(),
      Soulpana.countDocuments({ status: "pending" }),
      Soulpana.countDocuments({ status: "answered" }),
      Souljar.countDocuments(),
      AuditLog.countDocuments({ action: "login", createdAt: { $gte: dayAgo } }),
      AdminUser.countDocuments({ isActive: true }),
    ]);

    // Revenue estimate (sessions × avg fee)
    const revenuePipeline = await Session.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$sessionFee" } } },
    ]);
    const totalRevenue = revenuePipeline[0]?.total ?? 0;

    // Weekly session trend (last 7 days)
    const weeklyTrend = await Session.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        count: { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);

    // Soulpana categories
    const soulpanaCategories = await Soulpana.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);

    // Application status breakdown
    const appStats = await SoulteeApplication.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const appStatusMap = Object.fromEntries(appStats.map(a => [a._id, a.count]));

    // SOULTEE category breakdown
    const categoryStats = await SoulteeApplication.aggregate([
      { $match: { status: "approved" } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]);

    res.json({
      users: {
        totalSoultees,
        activeSoultees,
        totalLinks,
        activeLinks,
        totalAdmins,
      },
      sessions: {
        total: totalSessions,
        completed: completedSessions,
        completionRate: totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) : 0,
        weeklyTrend,
      },
      revenue: {
        total: totalRevenue,
        currency: "NPR",
      },
      applications: {
        pending:          pendingApplications,
        approvedThisMonth,
        rejected:         rejectedApplications,
        byStatus:         appStatusMap,
        byCategory:       Object.fromEntries(categoryStats.map(c => [c._id || "Unknown", c.count])),
      },
      soulpana: {
        total:    totalSoulpana,
        pending:  pendingSoulpana,
        answered: answeredSoulpana,
        closed:   totalSoulpana - pendingSoulpana - answeredSoulpana,
        byCategory: soulpanaCategories.map(c => ({ category: c._id || "Other", count: c.count })),
      },
      souljar: { total: totalSouljar },
      system: {
        recentAdminLogins: recentLogins,
        health: "healthy",
        uptime: process.uptime(),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  USER MANAGEMENT (Firestore-backed)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users?search=&role=&status=&limit=&page=
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const db      = getFirestore();
    const limit   = Math.min(100, parseInt(req.query.limit) || 20);
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const search  = (req.query.search || "").toLowerCase().trim();
    const roleFilter   = req.query.role   || "";
    const statusFilter = req.query.status || "";

    let query = db.collection("users");

    // Fetch all (Firestore client-side filtering — acceptable for admin panel)
    const snapshot = await query.get();
    let users = [];
    snapshot.forEach(doc => users.push({ uid: doc.id, ...doc.data() }));

    // Apply filters
    if (search) {
      users = users.filter(u =>
        (u.name || "").toLowerCase().includes(search) ||
        (u.email || "").toLowerCase().includes(search) ||
        (u.phone || "").includes(search)
      );
    }
    if (roleFilter) {
      users = users.filter(u => (u.role || "").toLowerCase() === roleFilter.toLowerCase());
    }
    if (statusFilter === "blocked") {
      users = users.filter(u => u.blocked === true);
    } else if (statusFilter === "active") {
      users = users.filter(u => !u.blocked);
    } else if (statusFilter === "pending") {
      users = users.filter(u => u.rolePending === true);
    }

    // Sort by creation time desc
    users.sort((a, b) => {
      const ta = a.createdAt?.seconds ?? 0;
      const tb = b.createdAt?.seconds ?? 0;
      return tb - ta;
    });

    const total  = users.length;
    const start  = (page - 1) * limit;
    const paged  = users.slice(start, start + limit);

    res.json({ users: paged, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/users/:uid
router.get("/users/:uid", requireAdmin, async (req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection("users").doc(req.params.uid).get();
    if (!doc.exists) return res.status(404).json({ message: "User not found" });

    // Also pull MongoDB data
    const soultee   = await Soultee.findOne({ firebaseUid: req.params.uid }).lean();
    const application = await SoulteeApplication.findOne({ firebaseUid: req.params.uid })
      .select("status category completenessScore riskFlags submittedAt")
      .lean();

    res.json({ user: { uid: doc.id, ...doc.data() }, soultee, application });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/users/:uid/block
router.patch(
  "/users/:uid/block",
  requireAdmin,
  requireRole("superAdmin", "securityAdmin"),
  async (req, res) => {
    const { reason = "" } = req.body;
    try {
      const db = getFirestore();
      await db.collection("users").doc(req.params.uid).update({
        blocked: true, blockedAt: new Date().toISOString(), blockedReason: reason,
      });
      await writeAuditLog(req, {
        action: "user_blocked", resourceType: "user", resourceId: req.params.uid,
        description: `User ${req.params.uid} blocked. Reason: ${reason || "not specified"}`,
        severity: "warn", metadata: { reason },
      });
      res.json({ message: "User blocked" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PATCH /api/admin/users/:uid/unblock
router.patch(
  "/users/:uid/unblock",
  requireAdmin,
  requireRole("superAdmin", "securityAdmin"),
  async (req, res) => {
    try {
      const db = getFirestore();
      await db.collection("users").doc(req.params.uid).update({
        blocked: false, blockedAt: null, blockedReason: null,
      });
      await writeAuditLog(req, {
        action: "user_unblocked", resourceType: "user", resourceId: req.params.uid,
        description: `User ${req.params.uid} unblocked`,
      });
      res.json({ message: "User unblocked" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PATCH /api/admin/users/:uid/role
router.patch(
  "/users/:uid/role",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { role } = req.body;
    if (!role) return res.status(400).json({ message: "role is required" });
    try {
      const db = getFirestore();
      await db.collection("users").doc(req.params.uid).update({ role });
      await writeAuditLog(req, {
        action: "user_role_changed", resourceType: "user", resourceId: req.params.uid,
        description: `User role changed to ${role}`,
        metadata: { newRole: role },
      });
      res.json({ message: "Role updated" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  AUDIT / SYSTEM LOGS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/audit-logs?action=&severity=&adminId=&page=&limit=
router.get("/audit-logs", requireAdmin, requireRole("superAdmin", "securityAdmin"), async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const limit    = Math.min(200, parseInt(req.query.limit) || 50);
    const skip     = (page - 1) * limit;
    const filter   = {};
    if (req.query.action)   filter.action   = req.query.action;
    if (req.query.severity) filter.severity = req.query.severity;
    if (req.query.adminId)  filter.adminId  = req.query.adminId;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/audit-logs  (client-triggered log — e.g., video viewed)
router.post("/audit-logs", requireAdmin, async (req, res) => {
  try {
    const { action, resourceType, resourceId, resourceName, description, severity, metadata } = req.body;
    const log = await AuditLog.create({
      adminId:      req.admin.id,
      adminName:    req.admin.name,
      adminRole:    req.admin.role,
      action:       action || "data_export",
      resourceType, resourceId, resourceName,
      description:  description || action,
      severity:     severity || "info",
      metadata:     metadata || {},
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({ log });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PLATFORM SETTINGS
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/settings?category=
router.get("/settings", requireAdmin, requireRole("superAdmin"), async (req, res) => {
  try {
    await SystemSettings.ensureDefaults();
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    const settings = await SystemSettings.find(filter).sort({ category: 1, key: 1 }).lean();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/settings/:key
router.patch("/settings/:key", requireAdmin, requireRole("superAdmin"), async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ message: "value is required" });
  try {
    const setting = await SystemSettings.findOneAndUpdate(
      { key: req.params.key },
      { value, updatedBy: req.admin.id, updatedByName: req.admin.name },
      { new: true }
    );
    if (!setting) return res.status(404).json({ message: "Setting not found" });
    await writeAuditLog(req, {
      action: "settings_updated", resourceType: "settings", resourceId: req.params.key,
      description: `Setting "${req.params.key}" updated to: ${JSON.stringify(value)}`,
      metadata: { key: req.params.key, value },
    });
    res.json({ setting });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN USER MANAGEMENT (list & manage admin accounts)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/admins?role=&search=
router.get("/admins", requireAdmin, requireRole("superAdmin"), async (req, res) => {
  try {
    const filter = { isActive: true };
    if (req.query.role) filter.role = req.query.role;
    if (req.query.search) {
      filter.$or = [
        { name:  { $regex: req.query.search, $options: "i" } },
        { email: { $regex: req.query.search, $options: "i" } },
      ];
    }
    const admins = await AdminUser.find(filter)
      .select("-passwordHash -resetToken -resetTokenExpiry")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ admins, total: admins.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/admin/admins/:id
router.delete(
  "/admins/:id",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    try {
      if (req.params.id === req.admin.id) {
        return res.status(400).json({ message: "Cannot delete your own account" });
      }
      const admin = await AdminUser.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
      if (!admin) return res.status(404).json({ message: "Admin not found" });
      await writeAuditLog(req, {
        action: "admin_deleted", resourceType: "admin", resourceId: req.params.id,
        resourceName: admin.name,
        description: `Admin account deactivated: ${admin.email}`,
        severity: "warn",
      });
      res.json({ message: "Admin deactivated" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  SOULPANA ADMIN MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/soulpana?status=&category=&soulteeType=&page=&limit=
router.get("/soulpana", requireAdmin, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const filter = {};
    if (req.query.status)     filter.status     = req.query.status;
    if (req.query.category)   filter.category   = req.query.category;
    if (req.query.soulteeType) filter.soulteeType = req.query.soulteeType;
    if (req.query.search) {
      filter.$or = [
        { title:       { $regex: req.query.search, $options: "i" } },
        { description: { $regex: req.query.search, $options: "i" } },
      ];
    }
    const [questions, total] = await Promise.all([
      Soulpana.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Soulpana.countDocuments(filter),
    ]);
    res.json({ questions, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/soulpana/:id/assign
router.patch(
  "/soulpana/:id/assign",
  requireAdmin,
  requireRole("superAdmin", "supportAdmin"),
  async (req, res) => {
    const { soulteeUid, soulteeName } = req.body;
    try {
      const q = await Soulpana.findByIdAndUpdate(
        req.params.id,
        { assignedSoulteeUid: soulteeUid, assignedSoulteeName: soulteeName },
        { new: true }
      );
      if (!q) return res.status(404).json({ message: "Question not found" });
      await writeAuditLog(req, {
        action: "soulpana_assigned", resourceType: "soulpana", resourceId: req.params.id,
        resourceName: q.title,
        description: `Soulpana question assigned to ${soulteeName}`,
        metadata: { soulteeUid, soulteeName },
      });
      res.json({ message: "Assigned", question: q });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// PATCH /api/admin/soulpana/:id/close
router.patch(
  "/soulpana/:id/close",
  requireAdmin,
  requireRole("superAdmin", "supportAdmin"),
  async (req, res) => {
    try {
      const q = await Soulpana.findByIdAndUpdate(
        req.params.id,
        { status: "closed" },
        { new: true }
      );
      if (!q) return res.status(404).json({ message: "Question not found" });
      await writeAuditLog(req, {
        action: "soulpana_closed", resourceType: "soulpana", resourceId: req.params.id,
        description: `Soulpana question "${q.title}" closed by admin`,
      });
      res.json({ message: "Closed" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  VIDEO ACCESS — Secure signed URL for SOULTEE intro videos
// ════════════════════════════════════════════════════════════════════════════

// GET /api/admin/media/signed-url?path=soultee-applications/uid/video.mp4
router.get("/media/signed-url", requireAdmin, async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ message: "path is required" });

  // Only allow paths within controlled directories
  const allowed = ["soultee-applications/", "admin-avatars/"];
  if (!allowed.some(prefix => filePath.startsWith(prefix))) {
    return res.status(403).json({ message: "Access denied to this file path" });
  }

  try {
    if (!admin.apps.length) return res.status(500).json({ message: "Firebase not initialised" });
    const bucket = admin.storage().bucket();
    const [url] = await bucket.file(filePath).getSignedUrl({
      action:  "read",
      expires: Date.now() + 60 * 60 * 1000, // 1-hour short-lived URL
    });
    // Log access
    await writeAuditLog(req, {
      action: "video_viewed", resourceType: "media", resourceId: filePath,
      description: `Admin viewed media: ${filePath}`,
    });
    res.json({ url, expiresIn: 3600 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SOULTEE APPLICATION MANAGEMENT
//  All routes require requireAdmin; sensitive ones also require requireRole.
// ════════════════════════════════════════════════════════════════════════════

// ─── Helper: send multi-channel notification to an applicant ─────────────────
async function notifyApplicant(io, { recipientUid, type, title, body, data = {} }) {
  const notification = await Notification.create({
    recipientUid,
    recipientRole: "student", // applicants are students before approval
    type,
    title,
    body,
    data,
  });

  // Socket.io → personal room
  io.to(`student:${recipientUid}`).emit("new_notification", {
    _id:       notification._id,
    type:      notification.type,
    title:     notification.title,
    body:      notification.body,
    data:      Object.fromEntries(notification.data || []),
    read:      false,
    createdAt: notification.createdAt,
  });

  // Firebase RTDB sync
  syncNotificationToRTDB(recipientUid, String(notification._id), {
    type, title, body,
    data,
    createdAt: notification.createdAt.getTime(),
    read: false,
  });

  // FCM push
  try {
    const tokenRecord = await FCMToken.findOne({ uid: recipientUid }).lean();
    if (tokenRecord) {
      const stringData = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      );
      await sendPushNotification(tokenRecord.token, title, body, stringData);
    }
  } catch (e) {
    if (
      e.code === "messaging/registration-token-not-registered" ||
      e.code === "messaging/invalid-registration-token"
    ) {
      await FCMToken.deleteOne({ uid: recipientUid });
    }
  }
}

// ─── GET /api/admin/applications/stats ───────────────────────────────────────
router.get("/applications/stats", requireAdmin, async (req, res) => {
  try {
    const [pending, under_review, approved, rejected, revision_requested] =
      await Promise.all([
        SoulteeApplication.countDocuments({ status: "pending" }),
        SoulteeApplication.countDocuments({ status: "under_review" }),
        SoulteeApplication.countDocuments({ status: "approved" }),
        SoulteeApplication.countDocuments({ status: "rejected" }),
        SoulteeApplication.countDocuments({ status: "revision_requested" }),
      ]);

    res.json({ pending, under_review, approved, rejected, revision_requested,
      total: pending + under_review + approved + rejected + revision_requested });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/applications ─────────────────────────────────────────────
// Query params: status, category, search, page, limit
router.get("/applications", requireAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.status   && req.query.status   !== "all") filter.status   = req.query.status;
    if (req.query.category && req.query.category !== "all") filter.category = req.query.category;
    if (req.query.search) {
      filter.$or = [
        { name:  { $regex: req.query.search, $options: "i" } },
        { email: { $regex: req.query.search, $options: "i" } },
        { phone: { $regex: req.query.search, $options: "i" } },
      ];
    }

    const [applications, total] = await Promise.all([
      SoulteeApplication.find(filter)
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-auditLog")
        .lean(),
      SoulteeApplication.countDocuments(filter),
    ]);

    res.json({ applications, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/applications/:id ─────────────────────────────────────────
router.get("/applications/:id", requireAdmin, async (req, res) => {
  try {
    const application = await SoulteeApplication.findById(req.params.id).lean();
    if (!application) return res.status(404).json({ message: "Application not found" });
    res.json({ application });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── PATCH /api/admin/applications/:id/mark-under-review ─────────────────────
router.patch(
  "/applications/:id/mark-under-review",
  requireAdmin,
  requireRole("superAdmin", "supportAdmin"),
  async (req, res) => {
    try {
      const application = await SoulteeApplication.findByIdAndUpdate(
        req.params.id,
        {
          status: "under_review",
          $push: {
            auditLog: {
              action:    "under_review",
              adminId:   req.admin.id,
              adminName: req.admin.name,
              comment:   "Application marked as under review",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!application) return res.status(404).json({ message: "Application not found" });
      res.json({ message: "Marked as under review", status: application.status });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ─── PATCH /api/admin/applications/:id/approve ───────────────────────────────
router.patch(
  "/applications/:id/approve",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { badge = "Silver", comment = "" } = req.body;

    if (!["Gold", "Silver", "Diamond"].includes(badge)) {
      return res.status(400).json({ message: "badge must be Gold, Silver, or Diamond" });
    }

    try {
      const application = await SoulteeApplication.findByIdAndUpdate(
        req.params.id,
        {
          status:       "approved",
          badgeLevel:   badge,
          adminComment: comment,
          reviewedBy:   req.admin.id,
          reviewedAt:   new Date(),
          $push: {
            auditLog: {
              action:    "approved",
              adminId:   req.admin.id,
              adminName: req.admin.name,
              comment:   comment || "Application approved",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!application) return res.status(404).json({ message: "Application not found" });

      // Sync approval to Firestore + upsert MongoDB Soultee profile
      try {
        const db = getFirestore();
        await db.collection("users").doc(application.firebaseUid).update({
          role:          "soultee",
          rolePending:   false,
          soulteeType:   application.category || "General",
          soulteeStatus: "Active",
          badge,
        });

        await Soultee.findOneAndUpdate(
          { firebaseUid: application.firebaseUid },
          {
            firebaseUid:     application.firebaseUid,
            name:            application.name,
            gender:          application.gender || "",
            specialization:  (application.specializations || []).join(", "),
            languages:       application.languages || [],
            feePerSession:   application.feePerSession || 0,
            bio:             application.bio || "",
            profileImage:    application.profileImageUrl || "",
            experienceYears: application.experienceYears || 0,
            status:          "offline",
          },
          { upsert: true, new: true }
        );
      } catch (firestoreErr) {
        console.error("[Admin Approve] Firestore sync error:", firestoreErr.message);
      }

      // Real-time notification to the applicant
      if (req.app.get("io")) {
        await notifyApplicant(req.app.get("io"), {
          recipientUid: application.firebaseUid,
          type:         "application_approved",
          title:        "Congratulations! Application Approved 🎉",
          body:         `Your SOULTEE application has been approved. You have been assigned a ${badge} badge.`,
          data: {
            type:       "application_approved",
            badge,
            category:   application.category || "",
          },
        });
      }

      res.json({ message: "Application approved", badge, status: "approved" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ─── PATCH /api/admin/applications/:id/reject ────────────────────────────────
router.patch(
  "/applications/:id/reject",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    const { comment = "" } = req.body;

    try {
      const application = await SoulteeApplication.findByIdAndUpdate(
        req.params.id,
        {
          status:       "rejected",
          adminComment: comment,
          reviewedBy:   req.admin.id,
          reviewedAt:   new Date(),
          $push: {
            auditLog: {
              action:    "rejected",
              adminId:   req.admin.id,
              adminName: req.admin.name,
              comment:   comment || "Application rejected",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!application) return res.status(404).json({ message: "Application not found" });

      // Revert Firestore role to Student if it was changed
      try {
        const db = getFirestore();
        await db.collection("users").doc(application.firebaseUid).update({
          rolePending: false,
        });
      } catch (_) { /* non-fatal */ }

      if (req.app.get("io")) {
        await notifyApplicant(req.app.get("io"), {
          recipientUid: application.firebaseUid,
          type:         "application_rejected",
          title:        "SOULTEE Application Update",
          body:         comment
            ? `Your application was not approved: ${comment}`
            : "Your SOULTEE application was not approved at this time.",
          data: { type: "application_rejected", comment },
        });
      }

      res.json({ message: "Application rejected", status: "rejected" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// ─── PATCH /api/admin/applications/:id/request-changes ───────────────────────
router.patch(
  "/applications/:id/request-changes",
  requireAdmin,
  requireRole("superAdmin", "supportAdmin"),
  async (req, res) => {
    const { comment = "" } = req.body;
    if (!comment.trim()) {
      return res.status(400).json({ message: "A feedback comment is required when requesting changes" });
    }

    try {
      const application = await SoulteeApplication.findByIdAndUpdate(
        req.params.id,
        {
          status:       "revision_requested",
          adminComment: comment,
          reviewedBy:   req.admin.id,
          reviewedAt:   new Date(),
          $push: {
            auditLog: {
              action:    "revision_requested",
              adminId:   req.admin.id,
              adminName: req.admin.name,
              comment,
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );
      if (!application) return res.status(404).json({ message: "Application not found" });

      if (req.app.get("io")) {
        await notifyApplicant(req.app.get("io"), {
          recipientUid: application.firebaseUid,
          type:         "application_revision_requested",
          title:        "Action Required: Update Your Application",
          body:         comment,
          data: { type: "application_revision_requested", comment },
        });
      }

      res.json({ message: "Revision requested", status: "revision_requested" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.delete(
  "/applications/:id",
  requireAdmin,
  requireRole("superAdmin"),
  async (req, res) => {
    try {
      const application = await SoulteeApplication.findById(req.params.id);
      if (!application) {
        return res.status(404).json({ message: "Application not found" });
      }

      const db = getFirestore();
      await clearSoulteeState(db, application.firebaseUid);
      await SoulteeApplication.findByIdAndDelete(req.params.id);

      res.json({ message: "Application deleted" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

export default router;

