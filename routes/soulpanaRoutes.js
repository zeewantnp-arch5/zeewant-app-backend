import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import Soulpana from "../models/Soulpana.js";
import Soultee from "../models/Soultee.js";
import { emitToUser } from "../services/notificationService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── File storage ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, "../uploads/soulpana"));
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|doc|docx/;

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const extOk = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowedTypes.test(file.mimetype);
    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error("Only images and documents (PDF, DOC, DOCX) are allowed"));
    }
  },
});

// ── Factory — receives io so routes can emit real-time events ─────────────
export default function createSoulpanaRoutes(io) {
  const router = express.Router();

  // ── POST /api/soulpana  ──  student submits emotional question ──────────────
  router.post("/", upload.array("attachments", 5), async (req, res) => {
    try {
      const { userId, title, category, soulteeType, description, anonymous, emotionTag } = req.body;

      if (!userId || !title || !category || !soulteeType || !description) {
        return res.status(400).json({ message: "All fields are required" });
      }

      // Check for existing pending question
      const existing = await Soulpana.findOne({ userId, status: "pending" });
      if (existing) {
        return res.status(409).json({
          message: "You already have one active question pending",
        });
      }

      const attachments = (req.files || []).map((f) => ({
        originalName: f.originalname,
        fileName: f.filename,
        mimeType: f.mimetype,
        size: f.size,
      }));

      const entry = await Soulpana.create({
        userId,
        title,
        category,
        soulteeType,
        description,
        emotionTag: emotionTag || null,
        anonymous: anonymous === "true" || anonymous === true,
        attachments,
      });

      // ── Respond immediately so the student is never blocked by socket work ──
      res.status(201).json(entry);

      // ── Real-time broadcast (fire-and-forget, never affects HTTP response) ──
      const payload = {
        questionId: entry._id,
        title: entry.title,
        category: entry.category,
        soulteeType: entry.soulteeType,
        emotionTag: entry.emotionTag,
        anonymous: entry.anonymous,
        createdAt: entry.createdAt,
      };

      io.emit("emotional_question_submitted", payload);

      Soultee.find({ status: { $in: ["online", "busy"] } })
        .select("firebaseUid")
        .lean()
        .then((soultees) => {
          soultees.forEach(({ firebaseUid }) => {
            emitToUser(io, "soultee", firebaseUid, "new_emotional_question", payload);
          });
        })
        .catch((err) => console.error("Socket broadcast error:", err.message));
    } catch (err) {
      console.error("Soulpana submit error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/pending/all  ──  soultee: list all pending questions ──
  router.get("/pending/all", async (req, res) => {
    try {
      const { soulteeType, emotionTag, page = 1, limit = 20 } = req.query;

      const filter = { status: "pending" };
      if (soulteeType) filter.soulteeType = soulteeType;
      if (emotionTag) filter.emotionTag = emotionTag;

      const skip = (Number(page) - 1) * Number(limit);

      const [questions, total] = await Promise.all([
        Soulpana.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        Soulpana.countDocuments(filter),
      ]);

      res.json({ questions, total, page: Number(page), limit: Number(limit) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/stats  ──  dashboard counts (pending / answered / closed)
  router.get("/stats", async (req, res) => {
    try {
      const [pending, answered, closed] = await Promise.all([
        Soulpana.countDocuments({ status: "pending" }),
        Soulpana.countDocuments({ status: "answered" }),
        Soulpana.countDocuments({ status: "closed" }),
      ]);
      res.json({ pending, answered, closed, total: pending + answered + closed });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/:userId  ──  student: get their own questions ──────────
  router.get("/:userId", async (req, res) => {
    try {
      const questions = await Soulpana.find({ userId: req.params.userId }).sort({
        createdAt: -1,
      });
      res.json(questions);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── PATCH /api/soulpana/:id/respond  ──  soultee responds to a question ──────
  router.patch("/:id/respond", async (req, res) => {
    try {
      const { soulteeResponse, respondedBy, respondedByName } = req.body;

      if (!soulteeResponse || !respondedBy) {
        return res.status(400).json({ message: "soulteeResponse and respondedBy are required" });
      }

      const updated = await Soulpana.findByIdAndUpdate(
        req.params.id,
        {
          soulteeResponse,
          respondedBy,
          respondedByName: respondedByName || null,
          respondedAt: new Date(),
          status: "answered",
        },
        { new: true }
      );

      if (!updated) return res.status(404).json({ message: "Question not found" });

      // ── Real-time: notify the student who asked ─────────────────────────────
      emitToUser(io, "student", updated.userId, "question_answered", {
        questionId: updated._id,
        title: updated.title,
        soulteeResponse: updated.soulteeResponse,
        respondedByName: updated.respondedByName,
        respondedAt: updated.respondedAt,
      });

      // Broadcast updated stats so dashboards refresh
      io.emit("emotional_question_answered", { questionId: updated._id });

      res.json(updated);
    } catch (err) {
      console.error("Soulpana respond error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── PATCH /api/soulpana/:id/status  ──  generic status update ───────────────
  router.patch("/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      const updated = await Soulpana.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
      );
      if (!updated) return res.status(404).json({ message: "Not found" });

      io.emit("emotional_question_status_changed", {
        questionId: updated._id,
        status: updated.status,
      });

      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
