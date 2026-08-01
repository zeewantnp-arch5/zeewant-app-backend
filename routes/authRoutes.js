import express from "express";
import bcrypt from "bcryptjs";
import admin from "firebase-admin";
import PhoneAuth from "../models/PhoneAuth.js";
import BiometricDevice from "../models/BiometricDevice.js";

const router = express.Router();

// ── GET /api/auth/has-password/:phone ─────────────────────────────────────────
// Returns { hasPassword: bool }
router.get("/has-password/:phone", async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone).trim();
    const exists = await PhoneAuth.exists({ phone });
    res.json({ hasPassword: !!exists });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/set-password ───────────────────────────────────────────────
// Set password for the first time (caller already authenticated via Firebase OTP).
// Body: { phone, firebaseUid, password }
router.post("/set-password", async (req, res) => {
  try {
    const { phone, firebaseUid, password } = req.body;
    if (!phone || !firebaseUid || !password)
      return res.status(400).json({ message: "phone, firebaseUid, and password are required" });
    if (password.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters" });

    const hash = await bcrypt.hash(password, 10);
    await PhoneAuth.findOneAndUpdate(
      { phone },
      { phone, firebaseUid, passwordHash: hash },
      { upsert: true, new: true }
    );
    res.json({ message: "Password set successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/login-password ─────────────────────────────────────────────
// Validate phone + password, return a Firebase custom token.
// Body: { phone, password }
router.post("/login-password", async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ message: "phone and password are required" });

    const record = await PhoneAuth.findOne({ phone });
    if (!record)
      return res.status(404).json({
        message: "No password set for this number. Please login with OTP first.",
        noPassword: true,
      });

    const valid = await bcrypt.compare(password, record.passwordHash);
    if (!valid)
      return res.status(401).json({ message: "Incorrect password." });

    if (!admin.apps.length)
      return res.status(503).json({ message: "Auth service unavailable. Please use OTP." });

    const customToken = await admin.auth().createCustomToken(record.firebaseUid);
    res.json({ customToken, firebaseUid: record.firebaseUid });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/change-password ────────────────────────────────────────────
// Change existing password — requires old password.
// Body: { phone, oldPassword, newPassword }
router.post("/change-password", async (req, res) => {
  try {
    const { phone, oldPassword, newPassword } = req.body;
    if (!phone || !oldPassword || !newPassword)
      return res.status(400).json({ message: "phone, oldPassword, and newPassword are required" });
    if (newPassword.length < 6)
      return res.status(400).json({ message: "New password must be at least 6 characters" });

    const record = await PhoneAuth.findOne({ phone });
    if (!record)
      return res.status(404).json({ message: "No password set for this number." });

    const valid = await bcrypt.compare(oldPassword, record.passwordHash);
    if (!valid)
      return res.status(401).json({ message: "Old password is incorrect." });

    record.passwordHash = await bcrypt.hash(newPassword, 10);
    await record.save();
    res.json({ message: "Password changed successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Reset password via OTP (no old password needed — Firebase OTP already verified).
// Body: { phone, firebaseUid, newPassword }
router.post("/reset-password", async (req, res) => {
  try {
    const { phone, firebaseUid, newPassword } = req.body;
    if (!phone || !firebaseUid || !newPassword)
      return res.status(400).json({ message: "phone, firebaseUid, and newPassword are required" });
    if (newPassword.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters" });

    const hash = await bcrypt.hash(newPassword, 10);
    await PhoneAuth.findOneAndUpdate(
      { phone },
      { phone, firebaseUid, passwordHash: hash },
      { upsert: true, new: true }
    );
    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/biometric/register ────────────────────────────────────────
// Called from Biometric Setup screen to register device.
// Body: { firebaseUid }
router.post("/biometric/register", async (req, res) => {
  try {
    const { firebaseUid } = req.body;
    if (!firebaseUid)
      return res.status(400).json({ message: "firebaseUid is required" });

    await BiometricDevice.findOneAndUpdate(
      { firebaseUid },
      { firebaseUid },
      { upsert: true, new: true }
    );
    res.json({ message: "Biometric registered" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/biometric/login ────────────────────────────────────────────
// Returns a Firebase custom token if UID is registered for biometric.
// Body: { firebaseUid }
router.post("/biometric/login", async (req, res) => {
  try {
    const { firebaseUid } = req.body;
    if (!firebaseUid)
      return res.status(400).json({ message: "firebaseUid is required" });

    const device = await BiometricDevice.findOne({ firebaseUid });
    if (!device)
      return res.status(404).json({ message: "Biometric not registered for this device." });

    if (!admin.apps.length)
      return res.status(503).json({ message: "Auth service unavailable." });

    const customToken = await admin.auth().createCustomToken(firebaseUid);

    // Record lastBiometricLogin timestamp (non-blocking)
    admin.firestore().collection('users').doc(firebaseUid).set(
      { lastBiometricLogin: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    ).catch(() => {});

    res.json({ customToken, firebaseUid });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
