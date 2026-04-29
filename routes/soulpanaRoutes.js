import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import Soulpana from "../models/Soulpana.js";
import SoulpanaComment from "../models/SoulpanaComment.js";
import Soultee from "../models/Soultee.js";
import { emitToUser, createNotification } from "../services/notificationService.js";
import { syncCommentInteractionToRTDB, syncCommentToRTDB, syncEngagementToRTDB } from "../config/firebase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Ensure upload directory exists (Render's filesystem is ephemeral) ─────────
const UPLOAD_DIR = path.join(__dirname, "../uploads/soulpana");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── File storage (only used when files are actually attached) ────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
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
    const ok = /jpeg|jpg|png|gif|webp|heic|heif|pdf|doc|docx/.test(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error(`File type not allowed. Accepted: JPEG, PNG, GIF, WEBP, HEIC, PDF, DOC, DOCX`), ok);
  },
});

// ── Conditionally apply multer only when request is multipart ────────────────
// Wraps Multer so errors (bad file type, size exceeded, disk failure) are
// returned as clean JSON 400 responses instead of falling through to
// Express's default HTML 500 error page.
function maybeMultipart(req, res, next) {
  if (!req.is("multipart/form-data")) {
    return next(); // JSON body — express.json() already parsed it
  }

  upload.array("attachments", 5)(req, res, (err) => {
    if (!err) return next();

    // Multer-specific errors (file type, size limit)
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ message: "File too large. Maximum size is 10 MB per file." });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ message: "Too many files. Maximum is 5 attachments." });
    }
    // fileFilter rejection or any other Multer/disk error
    return res.status(400).json({ message: err.message || "File upload failed." });
  });
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
        questionId:         entry._id,
        _id:                entry._id,
        title:              entry.title,
        category:           entry.category,
        emotionTag:         entry.emotionTag,
        anonymous:          entry.anonymous,
        description:        entry.description,
        assignedSoulteeUid: entry.assignedSoulteeUid,
        mediaUrls:          entry.mediaUrls,
        createdAt:          entry.createdAt,
        status:             'pending',
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
      const { soulteeUid, emotionTag, page = 1, limit = 15 } = req.query;
      const pageNum  = Math.max(1, Number(page));
      const limitNum = Math.min(50, Math.max(1, Number(limit))); // cap at 50

      // Include both pending and answered so soultees can see their full history.
      // Closed questions are excluded (archived/removed from view).
      const filter = { status: { $in: ["pending", "answered"] } };

      // Soultee sees questions assigned directly to them OR unassigned ones
      if (soulteeUid) {
        filter.$or = [
          { assignedSoulteeUid: soulteeUid },
          { assignedSoulteeUid: null },
        ];
      }
      if (emotionTag) filter.emotionTag = emotionTag;

      const skip = (pageNum - 1) * limitNum;

      // Use lean() for performance; virtuals don't run with lean() so we
      // compute likeCount / dislikeCount from the array lengths manually.
      const [questions, total] = await Promise.all([
        Soulpana.find(filter)
          .sort({ createdAt: -1 })   // newest first — permanent, index-backed
          .skip(skip)
          .limit(limitNum)
          .lean(),
        Soulpana.countDocuments(filter),
      ]);

      const enriched = questions.map((q) => ({
        ...q,
        likeCount:    (q.likes    ?? []).length,
        dislikeCount: (q.dislikes ?? []).length,
      }));

      res.json({
        questions: enriched,
        total,
        page:    pageNum,
        limit:   limitNum,
        hasMore: pageNum * limitNum < total,
      });
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
      const { authorId, authorName, authorRole, text, parentCommentId } = req.body;
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
        parentCommentId: parentCommentId || null,
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
      io.to(`question:${questionId}`).emit("comment_interaction_updated", {
        questionId,
        commentId: commentData._id,
        parentCommentId: commentData.parentCommentId,
        type: parentCommentId ? "reply" : "comment",
      });

      syncCommentInteractionToRTDB(questionId, String(commentData._id), {
        type: parentCommentId ? "reply" : "comment",
        parentCommentId: commentData.parentCommentId,
      });
      // Signal RTDB so Flutter listeners wake up without polling
      syncCommentToRTDB(questionId, String(commentData._id), {
        authorRole: authorRole,
        isReply:    !!parentCommentId,
      });

      // ── Broadcast list-level activity so both sides can show unread badges ──
      // Any socket on either side watching the question list receives this event.
      const activityPayload = {
        questionId,
        authorRole,
        authorName,
        preview: text.trim().slice(0, 80),
        isReply: !!parentCommentId,
        commentId: String(commentData._id),
      };
      io.emit("question_activity", activityPayload);

      // ── Personal-room notifications so users NOT in the thread also get it ─
      if (authorRole === "soultee") {
        // Soultee replied → notify the question owner (student)
        emitToUser(io, "student", question.userId, "new_comment", commentData);
        emitToUser(io, "student", question.userId, "question_activity", activityPayload);

        // Persist notification + FCM push to student
        createNotification(io, {
          recipientUid:  question.userId,
          recipientRole: "student",
          type:          "new_comment",
          title:         `${authorName} commented on your question`,
          body:          text.trim().slice(0, 100),
          data: {
            type:       "new_comment",
            questionId: String(questionId),
            commentId:  String(commentData._id),
            authorName,
            authorRole: "soultee",
          },
        }).catch((err) => console.error("[Comment notify] error:", err.message));
      } else {
        // Student commented → notify assigned soultee (if any) + soultees who replied before
        const notifyUids = new Set();
        if (question.assignedSoulteeUid) notifyUids.add(question.assignedSoulteeUid);
        const soulteeCommenters = await SoulpanaComment.distinct("authorId", {
          questionId,
          authorRole: "soultee",
        });
        soulteeCommenters.forEach((uid) => notifyUids.add(uid));
        notifyUids.forEach((uid) => {
          emitToUser(io, "soultee", uid, "new_comment", commentData);
          emitToUser(io, "soultee", uid, "question_activity", activityPayload);
        });
      }

      res.status(201).json(commentData);
    } catch (err) {
      console.error("Comment post error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/soulpana/:questionId/comments/:commentId/like ──────────────
  router.post("/:questionId/comments/:commentId/like", async (req, res) => {
    try {
      const { userId } = req.body;
      const { questionId, commentId } = req.params;
      if (!userId) return res.status(400).json({ message: "userId is required" });

      const comment = await SoulpanaComment.findOne({ _id: commentId, questionId })
        .select("likes dislikes")
        .lean();
      if (!comment) return res.status(404).json({ message: "Comment not found" });

      const alreadyLiked = (comment.likes || []).includes(userId);
      if (alreadyLiked) {
        await SoulpanaComment.findByIdAndUpdate(commentId, { $pull: { likes: userId } });
      } else {
        await SoulpanaComment.findByIdAndUpdate(commentId, {
          $addToSet: { likes: userId },
          $pull: { dislikes: userId },
        });
      }

      const updated = await SoulpanaComment.findById(commentId)
        .select("likes dislikes parentCommentId")
        .lean();

      const payload = {
        questionId,
        commentId,
        actorId: userId,
        parentCommentId: updated.parentCommentId,
        likeCount: (updated.likes || []).length,
        dislikeCount: (updated.dislikes || []).length,
        userLiked: (updated.likes || []).includes(userId),
        userDisliked: (updated.dislikes || []).includes(userId),
      };

      io.to(`question:${questionId}`).emit("comment_liked", payload);
      io.to(`question:${questionId}`).emit("comment_interaction_updated", {
        questionId,
        commentId,
        type: "like",
      });

      syncCommentInteractionToRTDB(questionId, commentId, {
        type: "like",
        likeCount: payload.likeCount,
        dislikeCount: payload.dislikeCount,
      });

      res.json(payload);
    } catch (err) {
      console.error("Comment like toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/soulpana/:questionId/comments/:commentId/dislike ───────────
  router.post("/:questionId/comments/:commentId/dislike", async (req, res) => {
    try {
      const { userId } = req.body;
      const { questionId, commentId } = req.params;
      if (!userId) return res.status(400).json({ message: "userId is required" });

      const comment = await SoulpanaComment.findOne({ _id: commentId, questionId })
        .select("likes dislikes")
        .lean();
      if (!comment) return res.status(404).json({ message: "Comment not found" });

      const alreadyDisliked = (comment.dislikes || []).includes(userId);
      if (alreadyDisliked) {
        await SoulpanaComment.findByIdAndUpdate(commentId, { $pull: { dislikes: userId } });
      } else {
        await SoulpanaComment.findByIdAndUpdate(commentId, {
          $addToSet: { dislikes: userId },
          $pull: { likes: userId },
        });
      }

      const updated = await SoulpanaComment.findById(commentId)
        .select("likes dislikes parentCommentId")
        .lean();

      const payload = {
        questionId,
        commentId,
        actorId: userId,
        parentCommentId: updated.parentCommentId,
        likeCount: (updated.likes || []).length,
        dislikeCount: (updated.dislikes || []).length,
        userLiked: (updated.likes || []).includes(userId),
        userDisliked: (updated.dislikes || []).includes(userId),
      };

      io.to(`question:${questionId}`).emit("comment_disliked", payload);
      io.to(`question:${questionId}`).emit("comment_interaction_updated", {
        questionId,
        commentId,
        type: "dislike",
      });

      syncCommentInteractionToRTDB(questionId, commentId, {
        type: "dislike",
        likeCount: payload.likeCount,
        dislikeCount: payload.dislikeCount,
      });

      res.json(payload);
    } catch (err) {
      console.error("Comment dislike toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/soulpana/detail/:id  ──  fetch a single question by MongoDB _id ──
  router.get("/detail/:id", async (req, res) => {
    try {
      const question = await Soulpana.findById(req.params.id).lean();
      if (!question) return res.status(404).json({ message: "Not found" });
      res.json({
        ...question,
        likeCount:    (question.likes    ?? []).length,
        dislikeCount: (question.dislikes ?? []).length,
      });
    } catch (err) {
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
