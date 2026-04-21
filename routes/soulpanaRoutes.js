import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import Soulpana from "../models/Soulpana.js";
import SoulpanaComment from "../models/SoulpanaComment.js";
import Soultee from "../models/Soultee.js";
import { emitToUser } from "../services/notificationService.js";
import { syncEngagementToRTDB } from "../config/firebase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── File storage (only used when files are actually attached) ────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, "../uploads/soulpana"));
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|pdf|doc|docx/.test(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error("File type not allowed"), ok);
  },
});

// ── Conditionally apply multer only when request is multipart ────────────────
function maybeMultipart(req, res, next) {
  if (req.is("multipart/form-data")) {
    return upload.array("attachments", 5)(req, res, next);
  }
  next(); // JSON or url-encoded — express.json() already parsed req.body
}

// ── Factory — receives io so routes can emit real-time events ─────────────
export default function createSoulpanaRoutes(io) {
  const router = express.Router();

  // ── POST /api/soulpana  ──  student submits emotional question ───────────────
  // Accepts both application/json and multipart/form-data
  router.post("/", maybeMultipart, async (req, res) => {
    try {
      const {
        userId, title, category, soulteeType,
        description, anonymous, emotionTag,
        assignedSoulteeUid, assignedSoulteeName,
        mediaUrls,   // Firebase Storage URLs pre-uploaded by the client
      } = req.body;

      if (!userId || !title || !category || !description) {
        return res.status(400).json({
          message: "userId, title, category, and description are required.",
        });
      }

      const existing = await Soulpana.findOne({ userId, status: "pending" });
      if (existing) {
        return res.status(409).json({ message: "You already have one active question pending" });
      }

      const attachments = (req.files || []).map((f) => ({
        originalName: f.originalname,
        fileName: f.filename,
        mimeType: f.mimetype,
        size: f.size,
      }));

      // Normalise mediaUrls — accept a JSON string, a comma-separated string,
      // or a plain array (Dio multipart sends each element as a separate field).
      let parsedMediaUrls = [];
      if (mediaUrls) {
        if (Array.isArray(mediaUrls)) {
          parsedMediaUrls = mediaUrls.filter(Boolean);
        } else if (typeof mediaUrls === "string") {
          try {
            const parsed = JSON.parse(mediaUrls);
            parsedMediaUrls = Array.isArray(parsed) ? parsed.filter(Boolean) : [parsed].filter(Boolean);
          } catch {
            parsedMediaUrls = mediaUrls.split(",").map((u) => u.trim()).filter(Boolean);
          }
        }
      }

      const entry = await Soulpana.create({
        userId,
        title,
        category,
        soulteeType: soulteeType || null,
        description,
        emotionTag: emotionTag || null,
        anonymous: anonymous === "true" || anonymous === true,
        assignedSoulteeUid: assignedSoulteeUid || null,
        assignedSoulteeName: assignedSoulteeName || null,
        attachments,
        mediaUrls: parsedMediaUrls,
      });

      // Respond immediately — socket work is fire-and-forget
      res.status(201).json(entry);

      const payload = {
        questionId: entry._id,
        title: entry.title,
        category: entry.category,
        emotionTag: entry.emotionTag,
        anonymous: entry.anonymous,
        assignedSoulteeUid: entry.assignedSoulteeUid,
        createdAt: entry.createdAt,
      };

      if (entry.assignedSoulteeUid) {
        // Notify the specific assigned soultee only
        emitToUser(io, "soultee", entry.assignedSoulteeUid, "new_emotional_question", payload);
      } else {
        // No specific soultee → broadcast to all online soultees
        io.emit("emotional_question_submitted", payload);
        Soultee.find({ status: { $in: ["online", "busy"] } })
          .select("firebaseUid").lean()
          .then((soultees) => {
            soultees.forEach(({ firebaseUid }) =>
              emitToUser(io, "soultee", firebaseUid, "new_emotional_question", payload)
            );
          })
          .catch((e) => console.error("Socket broadcast error:", e.message));
      }

    } catch (err) {
      console.error("Soulpana submit error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/pending/all  ──  soultee queue ────────────────────────
  router.get("/pending/all", async (req, res) => {
    try {
      const { soulteeUid, emotionTag, page = 1, limit = 20 } = req.query;
      const filter = { status: "pending" };
      // Filter to only questions assigned to this soultee (or unassigned ones)
      if (soulteeUid) {
        filter.$or = [
          { assignedSoulteeUid: soulteeUid },
          { assignedSoulteeUid: null },
        ];
      }
      if (emotionTag) filter.emotionTag = emotionTag;

      const skip = (Number(page) - 1) * Number(limit);
      const [questions, total] = await Promise.all([
        Soulpana.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        Soulpana.countDocuments(filter),
      ]);
      res.json({ questions, total, page: Number(page), limit: Number(limit) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/stats  ──  pending / answered / closed counts ──────────
  router.get("/stats", async (_req, res) => {
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

  // ── GET /api/soulpana/:questionId/comments  ──  load thread ─────────────────
  router.get("/:questionId/comments", async (req, res) => {
    try {
      const comments = await SoulpanaComment.find({
        questionId: req.params.questionId,
      }).sort({ createdAt: 1 }).lean();
      res.json(comments);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/soulpana/:questionId/comments  ──  post a comment ─────────────
  router.post("/:questionId/comments", async (req, res) => {
    try {
      const { authorId, authorName, authorRole, text } = req.body;
      const { questionId } = req.params;

      if (!authorId || !authorName || !authorRole || !text?.trim()) {
        return res.status(400).json({ message: "authorId, authorName, authorRole, text are required" });
      }

      // Verify the question exists
      const question = await Soulpana.findById(questionId).lean();
      if (!question) return res.status(404).json({ message: "Question not found" });

      const comment = await SoulpanaComment.create({
        questionId,
        authorId,
        authorName,
        authorRole,
        text: text.trim(),
      });

      // If question is still pending and a soultee comments → mark answered
      if (question.status === "pending" && authorRole === "soultee") {
        await Soulpana.findByIdAndUpdate(questionId, {
          status: "answered",
          respondedBy: authorId,
          respondedByName: authorName,
          respondedAt: new Date(),
        });
        io.emit("emotional_question_answered", { questionId });
      }

      const commentData = comment.toObject();

      // Emit to the question's socket room so both parties get it live
      io.to(`question:${questionId}`).emit("new_comment", commentData);

      // Also notify the other party via their personal room
      if (authorRole === "soultee") {
        emitToUser(io, "student", question.userId, "new_comment", commentData);
      } else {
        // notify all soultees who have commented on this question
        const soulteeCommenters = await SoulpanaComment.distinct("authorId", {
          questionId,
          authorRole: "soultee",
        });
        soulteeCommenters.forEach((uid) =>
          emitToUser(io, "soultee", uid, "new_comment", commentData)
        );
      }

      res.status(201).json(commentData);
    } catch (err) {
      console.error("Comment post error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/:userId  ──  student: their own questions ──────────────
  // NOTE: keep this AFTER the more-specific routes above
  router.get("/:userId", async (req, res) => {
    try {
      const questions = await Soulpana.find({ userId: req.params.userId })
        .sort({ createdAt: -1 });
      res.json(questions);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── PATCH /api/soulpana/:id/respond  ──  legacy single-response (kept for compat)
  router.patch("/:id/respond", async (req, res) => {
    try {
      const { soulteeResponse, respondedBy, respondedByName } = req.body;
      if (!soulteeResponse || !respondedBy) {
        return res.status(400).json({ message: "soulteeResponse and respondedBy are required" });
      }
      const updated = await Soulpana.findByIdAndUpdate(
        req.params.id,
        { soulteeResponse, respondedBy, respondedByName: respondedByName || null, respondedAt: new Date(), status: "answered" },
        { new: true }
      );
      if (!updated) return res.status(404).json({ message: "Not found" });
      emitToUser(io, "student", updated.userId, "question_answered", {
        questionId: updated._id,
        title: updated.title,
        soulteeResponse: updated.soulteeResponse,
        respondedByName: updated.respondedByName,
        respondedAt: updated.respondedAt,
      });
      io.emit("emotional_question_answered", { questionId: updated._id });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── PATCH /api/soulpana/:id/status  ──  generic status update ───────────────
  router.patch("/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      const updated = await Soulpana.findByIdAndUpdate(req.params.id, { status }, { new: true });
      if (!updated) return res.status(404).json({ message: "Not found" });
      io.emit("emotional_question_status_changed", { questionId: updated._id, status: updated.status });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/soulpana/:id/like  ──  toggle like ────────────────────────────
  // Body: { userId }
  // Returns: { questionId, likeCount, dislikeCount, userLiked, userDisliked }
  router.post("/:id/like", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ message: "userId is required" });

      const question = await Soulpana.findById(req.params.id).select("likes dislikes").lean();
      if (!question) return res.status(404).json({ message: "Question not found" });

      const alreadyLiked = question.likes.includes(userId);

      if (alreadyLiked) {
        // Toggle off — remove the like
        await Soulpana.findByIdAndUpdate(req.params.id, { $pull: { likes: userId } });
      } else {
        // Like and atomically remove any existing dislike from the same user
        await Soulpana.findByIdAndUpdate(req.params.id, {
          $addToSet: { likes: userId },
          $pull:      { dislikes: userId },
        });
      }

      const updated = await Soulpana.findById(req.params.id).select("likes dislikes").lean();
      const payload = {
        questionId:   req.params.id,
        likeCount:    updated.likes.length,
        dislikeCount: updated.dislikes.length,
        userLiked:    updated.likes.includes(userId),
        userDisliked: updated.dislikes.includes(userId),
      };

      // Broadcast to question room (open thread) and all connected clients (list views)
      io.to(`question:${req.params.id}`).emit("engagement_updated", payload);
      io.emit("engagement_updated", payload);

      // Fire-and-forget RTDB sync for Firebase real-time listeners
      syncEngagementToRTDB(req.params.id, payload.likeCount, payload.dislikeCount);

      res.json(payload);
    } catch (err) {
      console.error("Like toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/soulpana/:id/dislike  ──  toggle dislike ──────────────────────
  // Body: { userId }
  // Returns: { questionId, likeCount, dislikeCount, userLiked, userDisliked }
  router.post("/:id/dislike", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ message: "userId is required" });

      const question = await Soulpana.findById(req.params.id).select("likes dislikes").lean();
      if (!question) return res.status(404).json({ message: "Question not found" });

      const alreadyDisliked = question.dislikes.includes(userId);

      if (alreadyDisliked) {
        // Toggle off — remove the dislike
        await Soulpana.findByIdAndUpdate(req.params.id, { $pull: { dislikes: userId } });
      } else {
        // Dislike and atomically remove any existing like from the same user
        await Soulpana.findByIdAndUpdate(req.params.id, {
          $addToSet: { dislikes: userId },
          $pull:      { likes: userId },
        });
      }

      const updated = await Soulpana.findById(req.params.id).select("likes dislikes").lean();
      const payload = {
        questionId:   req.params.id,
        likeCount:    updated.likes.length,
        dislikeCount: updated.dislikes.length,
        userLiked:    updated.likes.includes(userId),
        userDisliked: updated.dislikes.includes(userId),
      };

      io.to(`question:${req.params.id}`).emit("engagement_updated", payload);
      io.emit("engagement_updated", payload);

      syncEngagementToRTDB(req.params.id, payload.likeCount, payload.dislikeCount);

      res.json(payload);
    } catch (err) {
      console.error("Dislike toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/:id/engagement  ──  fetch counts + caller's reaction ──
  // Query: ?userId=<firebaseUid>  (optional — omit to skip user-specific flags)
  router.get("/:id/engagement", async (req, res) => {
    try {
      const question = await Soulpana.findById(req.params.id)
        .select("likes dislikes")
        .lean();
      if (!question) return res.status(404).json({ message: "Question not found" });

      const { userId } = req.query;
      res.json({
        questionId:   req.params.id,
        likeCount:    question.likes.length,
        dislikeCount: question.dislikes.length,
        userLiked:    userId ? question.likes.includes(userId) : null,
        userDisliked: userId ? question.dislikes.includes(userId) : null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Socket: let clients join a question's room for live comments ─────────────
  // Handled in realtimeServer.js via  socket.emit("join_question", { questionId })

  return router;
}
