import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileTypeFromFile } from "file-type";
import { fileURLToPath } from "url";
import { dirname } from "path";
import Soulpana from "../models/Soulpana.js";
import SoulpanaComment from "../models/SoulpanaComment.js";
import Soultee from "../models/Soultee.js";
import { createNotification } from "../services/notificationService.js";
import { syncCommentInteractionToRTDB, syncCommentToRTDB, syncEngagementToRTDB } from "../config/firebase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- Ensure upload directory exists --------------------------------------------
const UPLOAD_DIR = path.join(__dirname, "../uploads/soulpana");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// -- File storage (only used when files are actually attached) ----------------
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

// The extension-only check above only rejects an obviously wrong filename —
// it doesn't stop someone renaming a malicious file to end in ".jpg". After
// Multer writes each file to disk, sniff its real magic bytes and reject
// anything whose actual content doesn't match an allowed type.
const ALLOWED_REAL_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/x-cfb", // legacy .doc (OLE compound file container)
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
]);

async function verifyUploadedFileContents(files) {
  for (const file of files) {
    const detected = await fileTypeFromFile(file.path);
    if (!detected || !ALLOWED_REAL_MIMES.has(detected.mime)) {
      await Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));
      return `"${file.originalname}" was rejected — its content doesn't match an allowed file type.`;
    }
  }
  return null;
}

// -- Conditionally apply multer only when request is multipart ----------------
// Wraps Multer so errors (bad file type, size exceeded, disk failure) are
// returned as clean JSON 400 responses instead of falling through to
// Express's default HTML 500 error page.
function maybeMultipart(req, res, next) {
  if (!req.is("multipart/form-data")) {
    return next(); // JSON body — express.json() already parsed it
  }

  upload.array("attachments", 5)(req, res, async (err) => {
    if (err) {
      // Multer-specific errors (file type, size limit)
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "File too large. Maximum size is 10 MB per file." });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ message: "Too many files. Maximum is 5 attachments." });
      }
      // fileFilter rejection or any other Multer/disk error
      return res.status(400).json({ message: err.message || "File upload failed." });
    }

    if (req.files?.length) {
      const rejectionMessage = await verifyUploadedFileContents(req.files);
      if (rejectionMessage) {
        return res.status(400).json({ message: rejectionMessage });
      }
    }

    next();
  });
}

// -- Factory — receives io so routes can emit real-time events -------------
export default function createSoulpanaRoutes() {
  const router = express.Router();

  // -- POST /api/soulpana  --  student submits emotional question ---------------
  // Accepts both application/json and multipart/form-data
  router.post("/", maybeMultipart, async (req, res) => {
    try {
      const {
        userId, title, category, soulteeType,
        description, anonymous, emotionTag,
        assignedSoulteeUid, assignedSoulteeName,
        mediaUrls,   // Firebase Storage URLs pre-uploaded by the client
        userName,    // student display name (omitted when posting anonymously)
      } = req.body;

      if (!userId || !title || !category || !description) {
        return res.status(400).json({
          message: "userId, title, category, and description are required.",
        });
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
      res.status(201).json(entry);

      const senderLabel = (anonymous === "true" || anonymous === true)
        ? "Someone"
        : (userName || "A student");

      if (entry.assignedSoulteeUid) {
        // Notify the specific assigned soultee — persisted notification + FCM push
        createNotification({
          recipientUid:  entry.assignedSoulteeUid,
          recipientRole: "soultee",
          type:          "new_emotional_question",
          title:         `${senderLabel} has a question for you`,
          body:          entry.title,
          data: {
            type:       "new_emotional_question",
            questionId: String(entry._id),
            category:   entry.category,
          },
        }).catch((e) => console.error("[Soulpana notify soultee] error:", e.message));
      } else {
        // No specific soultee ? notify every soultee through persisted notification + FCM
        Soultee.find({}).select("firebaseUid").lean()
          .then((soultees) => {
            soultees.forEach(({ firebaseUid }) => {
              createNotification({
                recipientUid:  firebaseUid,
                recipientRole: "soultee",
                type:          "new_emotional_question",
                title:         "New question in Soulpan",
                body:          entry.title,
                data: {
                  type:       "new_emotional_question",
                  questionId: String(entry._id),
                  category:   entry.category,
                },
              }).catch(() => {});
            });
          })
          .catch((e) => console.error("[Soulpana broadcast] error:", e.message));
      }

    } catch (err) {
      console.error("Soulpana submit error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // -- GET /api/soulpana/pending/all  --  soultee queue ------------------------
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

  // -- GET /api/soulpana/stats  --  pending / answered / closed counts ----------
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

  // -- GET /api/soulpana/:questionId/comments  --  load thread -----------------
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

  // -- POST /api/soulpana/:questionId/comments  --  post a comment -------------
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

      // If question is still pending and a soultee comments ? mark answered
      if (question.status === "pending" && authorRole === "soultee") {
        await Soulpana.findByIdAndUpdate(questionId, {
          status: "answered",
          respondedBy: authorId,
          respondedByName: authorName,
          respondedAt: new Date(),
        });
      }

      const commentData = comment.toObject();

      syncCommentInteractionToRTDB(questionId, String(commentData._id), {
        type: parentCommentId ? "reply" : "comment",
        parentCommentId: commentData.parentCommentId,
      });
      // Signal RTDB so Flutter listeners wake up without polling
      syncCommentToRTDB(questionId, String(commentData._id), {
        authorRole: authorRole,
        isReply:    !!parentCommentId,
      });
      // Persist notifications so users not in the thread also get it.
      if (authorRole === "soultee") {
        // Soultee replied ? notify the question owner (student)

        // Persist notification + FCM push to student
        createNotification({
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
        // Student commented ? notify assigned soultee (if any) + soultees who replied before
        const notifyUids = new Set();
        if (question.assignedSoulteeUid) notifyUids.add(question.assignedSoulteeUid);
        const soulteeCommenters = await SoulpanaComment.distinct("authorId", {
          questionId,
          authorRole: "soultee",
        });
        soulteeCommenters.forEach((uid) => notifyUids.add(uid));

        // Persistent notification + FCM push for each soultee
        const notifyPromises = [...notifyUids].map((uid) => {
          return createNotification({
            recipientUid:  uid,
            recipientRole: "soultee",
            type:          "new_comment",
            title:         `${authorName} replied on a question you're following`,
            body:          text.trim().slice(0, 100),
            data: {
              type:       "new_comment",
              questionId: String(questionId),
              commentId:  String(commentData._id),
              authorName,
              authorRole: "student",
            },
          });
        });
        Promise.all(notifyPromises).catch((err) =>
          console.error("[Comment notify soultee] error:", err.message)
        );
      }

      res.status(201).json(commentData);
    } catch (err) {
      console.error("Comment post error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // -- POST /api/soulpana/:questionId/comments/:commentId/like --------------
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

  // -- POST /api/soulpana/:questionId/comments/:commentId/dislike -----------
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

  // -- GET /api/soulpana/detail/:id  --  fetch a single question by MongoDB _id --
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

  // -- GET /api/soulpana/:userId  --  student: their own questions --------------
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

  // -- PATCH /api/soulpana/:id/respond  --  legacy single-response (kept for compat)
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
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // -- PATCH /api/soulpana/:id/status  --  generic status update ---------------
  router.patch("/:id/status", async (req, res) => {
    try {
      const { status } = req.body;
      const updated = await Soulpana.findByIdAndUpdate(req.params.id, { status }, { new: true });
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // -- POST /api/soulpana/:id/like  --  toggle like ----------------------------
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

      // Fire-and-forget RTDB sync for Firebase real-time listeners
      syncEngagementToRTDB(req.params.id, payload.likeCount, payload.dislikeCount);

      res.json(payload);
    } catch (err) {
      console.error("Like toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // -- POST /api/soulpana/:id/dislike  --  toggle dislike ----------------------
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

      syncEngagementToRTDB(req.params.id, payload.likeCount, payload.dislikeCount);

      res.json(payload);
    } catch (err) {
      console.error("Dislike toggle error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // -- GET /api/soulpana/:id/engagement  --  fetch counts + caller's reaction --
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
  return router;
}
