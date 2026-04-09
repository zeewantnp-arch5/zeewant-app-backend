import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import Soulpana from "../models/Soulpana.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── File storage ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../uploads/soulpana"));
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const allowedTypes = /jpeg|jpg|png|gif|webp|pdf|doc|docx/;

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const extOk = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowedTypes.test(file.mimetype);
    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error("Only images and documents (PDF, DOC, DOCX) are allowed"));
    }
  },
});

// ── POST /api/soulpana  ──  submit a question ────────────────────────────────
router.post("/", upload.array("attachments", 5), async (req, res) => {
  try {
    const { userId, title, category, soulteeType, description, anonymous } = req.body;

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
      anonymous: anonymous === "true" || anonymous === true,
      attachments,
    });

    res.status(201).json(entry);
  } catch (err) {
    console.error("Soulpana submit error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/soulpana/:userId  ──  get user's questions ─────────────────────
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

// ── PATCH /api/soulpana/:id/status  ──  soultee updates status ──────────────
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const updated = await Soulpana.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
