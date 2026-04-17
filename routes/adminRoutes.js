import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import Souljar from "../models/souljar.js";
import Soultee from "../models/Soultee.js";
import AdminUser, { ADMIN_ROLES } from "../models/AdminUser.js";
import admin from "../config/firebase.js";

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
// Generates a 6-digit reset code valid for 15 minutes.
// Since this is an internal panel with no email service, the code is returned
// directly in the response so the UI can display it to the user.
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
      return res.json({ message: "If that email exists, a reset code has been generated." });
    }

    // Generate a 6-digit code, expire in 15 minutes
    const code = String(Math.floor(100000 + Math.random() * 900000));
    adminUser.resetToken = code;
    adminUser.resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await adminUser.save();

    console.log(`[Admin Reset] Code for ${email}: ${code}`);

    res.json({
      message: "Reset code generated.",
      // Return code directly (internal panel — no email service)
      resetCode: code,
      expiresIn: "15 minutes",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
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

export default router;
