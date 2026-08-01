import express from "express";
import crypto from "crypto";
import UserSettings from "../models/UserSettings.js";

const router = express.Router();
const MAX_RECOVERY_ATTEMPTS = 5;
const RECOVERY_LOCK_MINUTES = 15;

const hashSecret = (secret) => {
  const pepper = process.env.JWT_SECRET || "zeewant_shield_pepper";
  return crypto
    .createHash("sha256")
    .update(`${pepper}:${secret}`)
    .digest("hex");
};

const hashPasskey = (passkey) => hashSecret(passkey);
const hashRecoveryCode = (recoveryCode) => hashSecret(recoveryCode);

const generateRecoveryCode = () => {
  // 10 uppercase chars keeps it easy to type but hard to guess.
  return crypto.randomBytes(5).toString("hex").toUpperCase();
};

// ─── GET /api/settings/shield/:userId ────────────────────────────────────────
// Returns { shieldEnabled: bool, hasPasskey: bool, hasRecoveryCode: bool }.
router.get("/shield/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const settings = await UserSettings.findOne({ userId });
    res.json({
      shieldEnabled: settings?.shieldEnabled ?? false,
      hasPasskey: Boolean(settings?.shieldPasskeyHash),
      hasRecoveryCode: Boolean(settings?.shieldRecoveryCodeHash),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── PUT /api/settings/shield/:userId ────────────────────────────────────────
// Body: { shieldEnabled: bool }
// Upserts the shield setting for the user.
router.put("/shield/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { shieldEnabled } = req.body;
    if (typeof shieldEnabled !== "boolean") {
      return res.status(400).json({ message: "shieldEnabled must be a boolean" });
    }

    const settings = await UserSettings.findOneAndUpdate(
      { userId },
      { shieldEnabled },
      { new: true, upsert: true }
    );

    res.json({ shieldEnabled: settings.shieldEnabled });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── PUT /api/settings/shield/passkey/:userId ───────────────────────────────
// Body: { passkey: "1234" }
router.put("/shield/passkey/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { passkey } = req.body;
    if (!/^\d{4}$/.test(passkey || "")) {
      return res.status(400).json({ message: "Passkey must be 4 digits" });
    }

    const passkeyHash = hashPasskey(passkey);
    const recoveryCode = generateRecoveryCode();
    const settings = await UserSettings.findOneAndUpdate(
      { userId },
      {
        shieldPasskeyHash: passkeyHash,
        shieldPasskeySetAt: new Date(),
        shieldRecoveryCodeHash: hashRecoveryCode(recoveryCode),
        shieldRecoveryCodeSetAt: new Date(),
        shieldRecoveryFailedAttempts: 0,
        shieldRecoveryLockedUntil: null,
        shieldEnabled: true,
      },
      { new: true, upsert: true }
    );

    res.json({
      message: "Passkey saved",
      shieldEnabled: settings.shieldEnabled,
      hasPasskey: Boolean(settings.shieldPasskeyHash),
      hasRecoveryCode: Boolean(settings.shieldRecoveryCodeHash),
      recoveryCode,
      recoveryCodeMessage:
        "Save this recovery code safely. It can reset Emotional Shield passkey if forgotten.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── POST /api/settings/shield/verify/:userId ───────────────────────────────
// Body: { passkey: "1234" }
router.post("/shield/verify/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { passkey } = req.body;
    if (!/^\d{4}$/.test(passkey || "")) {
      return res.status(400).json({ message: "Passkey must be 4 digits" });
    }

    const settings = await UserSettings.findOne({ userId });
    if (!settings?.shieldPasskeyHash) {
      return res.status(404).json({ message: "Passkey not set" });
    }

    const valid = settings.shieldPasskeyHash === hashPasskey(passkey);
    res.json({ valid });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── POST /api/settings/shield/recover/:userId ──────────────────────────────
// Body: { recoveryCode: "AB12CD34EF", newPasskey: "1234" }
router.post("/shield/recover/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { recoveryCode, newPasskey } = req.body;
    if (!/^[A-Z0-9]{8,20}$/.test((recoveryCode || "").trim().toUpperCase())) {
      return res.status(400).json({
        message: "Recovery code must be 8-20 characters (A-Z, 0-9)",
      });
    }
    if (!/^\d{4}$/.test(newPasskey || "")) {
      return res.status(400).json({ message: "New passkey must be 4 digits" });
    }

    const settings = await UserSettings.findOne({ userId });
    if (!settings?.shieldRecoveryCodeHash) {
      return res.status(404).json({ message: "Recovery code not set" });
    }

    if (
      settings.shieldRecoveryLockedUntil &&
      settings.shieldRecoveryLockedUntil > new Date()
    ) {
      return res.status(429).json({
        message: "Recovery temporarily locked. Please try again later.",
        lockedUntil: settings.shieldRecoveryLockedUntil,
      });
    }

    const normalizedRecoveryCode = recoveryCode.trim().toUpperCase();
    const valid = settings.shieldRecoveryCodeHash === hashRecoveryCode(normalizedRecoveryCode);

    if (!valid) {
      const nextAttempts = (settings.shieldRecoveryFailedAttempts || 0) + 1;
      settings.shieldRecoveryFailedAttempts = nextAttempts;

      if (nextAttempts >= MAX_RECOVERY_ATTEMPTS) {
        settings.shieldRecoveryFailedAttempts = 0;
        settings.shieldRecoveryLockedUntil = new Date(
          Date.now() + RECOVERY_LOCK_MINUTES * 60 * 1000
        );
      }

      await settings.save();
      return res.status(401).json({ message: "Invalid recovery code" });
    }

    const rotatedRecoveryCode = generateRecoveryCode();
    settings.shieldPasskeyHash = hashPasskey(newPasskey);
    settings.shieldPasskeySetAt = new Date();
    settings.shieldRecoveryCodeHash = hashRecoveryCode(rotatedRecoveryCode);
    settings.shieldRecoveryCodeSetAt = new Date();
    settings.shieldRecoveryFailedAttempts = 0;
    settings.shieldRecoveryLockedUntil = null;
    settings.shieldEnabled = true;
    await settings.save();

    res.json({
      message: "Passkey reset successfully using recovery code",
      shieldEnabled: settings.shieldEnabled,
      hasPasskey: Boolean(settings.shieldPasskeyHash),
      hasRecoveryCode: Boolean(settings.shieldRecoveryCodeHash),
      recoveryCode: rotatedRecoveryCode,
      recoveryCodeMessage:
        "Your recovery code was rotated. Save the new code safely.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── POST /api/settings/shield/recovery-code/rotate/:userId ─────────────────
// Body: { passkey: "1234" }
router.post("/shield/recovery-code/rotate/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { passkey } = req.body;
    if (!/^\d{4}$/.test(passkey || "")) {
      return res.status(400).json({ message: "Passkey must be 4 digits" });
    }

    const settings = await UserSettings.findOne({ userId });
    if (!settings?.shieldPasskeyHash) {
      return res.status(404).json({ message: "Passkey not set" });
    }

    const validPasskey = settings.shieldPasskeyHash === hashPasskey(passkey);
    if (!validPasskey) {
      return res.status(401).json({ message: "Invalid passkey" });
    }

    const recoveryCode = generateRecoveryCode();
    settings.shieldRecoveryCodeHash = hashRecoveryCode(recoveryCode);
    settings.shieldRecoveryCodeSetAt = new Date();
    settings.shieldRecoveryFailedAttempts = 0;
    settings.shieldRecoveryLockedUntil = null;
    await settings.save();

    res.json({
      message: "Recovery code rotated",
      hasRecoveryCode: true,
      recoveryCode,
      recoveryCodeMessage:
        "Save this recovery code safely. Old recovery code is no longer valid.",
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─── DELETE /api/settings/shield/passkey/:userId ────────────────────────────
// Body: { passkey: "1234" }
router.delete("/shield/passkey/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const { passkey } = req.body;
    if (!/^\d{4}$/.test(passkey || "")) {
      return res.status(400).json({ message: "Passkey must be 4 digits" });
    }

    const settings = await UserSettings.findOne({ userId });
    if (!settings?.shieldPasskeyHash) {
      return res.status(404).json({ message: "Passkey not set" });
    }

    const valid = settings.shieldPasskeyHash === hashPasskey(passkey);
    if (!valid) {
      return res.status(401).json({ message: "Invalid passkey" });
    }

    settings.shieldPasskeyHash = null;
    settings.shieldPasskeySetAt = null;
    settings.shieldRecoveryCodeHash = null;
    settings.shieldRecoveryCodeSetAt = null;
    settings.shieldRecoveryFailedAttempts = 0;
    settings.shieldRecoveryLockedUntil = null;
    settings.shieldEnabled = false;
    await settings.save();

    res.json({ message: "Passkey removed", shieldEnabled: false, hasPasskey: false });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
