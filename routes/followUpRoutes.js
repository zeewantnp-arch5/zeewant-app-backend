import express from "express";
import FollowUpCode from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode() {
  const suffix = Array.from(
    { length: 5 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join("");
  return `ZW-7D-${suffix}`;
}

export default function createFollowUpRoutes(io) {
  const router = express.Router();

  // ─── GET /api/follow-up/:roomId/status ─────────────────────────────────────
  // Returns current lock state and follow-up status for a room
  router.get("/:roomId/status", async (req, res) => {
    try {
      const { roomId } = req.params;
      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });

      const activeCode  = await FollowUpCode.findOne({ roomId, status: "active"  }).lean();
      const pendingCode = await FollowUpCode.findOne({ roomId, status: "pending" }).lean();

      res.json({
        chatLocked:     link.chatLocked ?? false,
        followUpActive: !!activeCode,
        followUpCode:   pendingCode?.code ?? null,
        expiresAt:      activeCode?.expiresAt ?? null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/generate ──────────────────────────────────
  // Soultee generates a follow-up access code after session ends
  router.post("/:roomId/generate", async (req, res) => {
    try {
      const { soulteeUid } = req.body;
      const { roomId } = req.params;

      if (!soulteeUid) return res.status(400).json({ message: "soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.soulteeFirebaseUid !== soulteeUid) return res.status(403).json({ message: "Not authorized" });
      if (!link.chatLocked) return res.status(400).json({ message: "Session is still active" });

      // Return existing pending code if already generated
      const existing = await FollowUpCode.findOne({ roomId, status: "pending" }).lean();
      if (existing) return res.json({ code: existing.code });

      // Generate unique code with collision retry
      let code;
      for (let i = 0; i < 10; i++) {
        const candidate = generateCode();
        const clash = await FollowUpCode.exists({ code: candidate });
        if (!clash) { code = candidate; break; }
      }
      if (!code) return res.status(500).json({ message: "Failed to generate unique code" });

      const followUp = await FollowUpCode.create({
        code,
        roomId,
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
      });

      // Emit only to soultee's personal room — student doesn't see the code automatically
      io.to(`soultee:${soulteeUid}`).emit("followup_code_generated", { roomId, code: followUp.code });

      res.json({ code: followUp.code });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/activate ──────────────────────────────────
  // Student enters the follow-up code to unlock chat for 7 days
  router.post("/:roomId/activate", async (req, res) => {
    try {
      const { studentUid, code } = req.body;
      const { roomId } = req.params;

      if (!studentUid || !code) return res.status(400).json({ message: "studentUid and code are required" });

      const followUp = await FollowUpCode.findOne({
        roomId,
        code: code.toUpperCase().trim(),
        status: "pending",
      });
      if (!followUp) return res.status(404).json({ message: "Invalid or already used code" });
      if (followUp.studentFirebaseUid !== studentUid) return res.status(403).json({ message: "Code is not valid for this student" });

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      followUp.status      = "active";
      followUp.activatedAt = new Date();
      followUp.expiresAt   = expiresAt;
      await followUp.save();

      // Unlock chat
      await StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: false });

      io.to(roomId).emit("followup_activated", { roomId, expiresAt: expiresAt.toISOString() });

      res.json({ success: true, expiresAt });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
