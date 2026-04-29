import express from "express";
import multer from "multer";
import Post, { POST_CATEGORIES } from "../models/Post.js";
import PostComment from "../models/PostComment.js";
import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";
import admin, {
  syncNotificationToRTDB,
  sendPushNotification,
  syncPostToRTDB,
  removePostFromRTDB,
  syncPostEngagementToRTDB,
} from "../config/firebase.js";

// ─── Allowed MIME types ───────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
const ALLOWED_AUDIO_TYPES = ["audio/mpeg", "audio/mp4", "audio/m4a", "audio/aac", "audio/wav",
                              "audio/ogg", "audio/webm", "audio/x-m4a"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm",
                              "video/x-matroska", "video/3gpp"];

const ALL_ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_AUDIO_TYPES, ...ALLOWED_VIDEO_TYPES];

// ── Size limits per media type ────────────────────────────────────────────────
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; //  10 MB
const AUDIO_MAX_BYTES =  3 * 1024 * 1024; //   3 MB
const VIDEO_MAX_BYTES =  5 * 1024 * 1024; //   5 MB

// ─── Multer: memory storage → stream to Firebase ─────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // hard cap at 10 MB; per-type checked below
  fileFilter: (_, file, cb) => {
    if (ALL_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  },
});

// ─── Upload a single buffer to Firebase Storage ───────────────────────────────
async function uploadMediaToFirebase(file, userId) {
  if (!admin.apps.length) throw new Error("Firebase not initialised");

  const bucket    = admin.storage().bucket();
  const ext       = file.originalname.split(".").pop().toLowerCase() || "bin";
  const timestamp = Date.now();
  const mediaPath = `posts/${userId}/${timestamp}.${ext}`;
  const fileRef   = bucket.file(mediaPath);

  await fileRef.save(file.buffer, {
    metadata: { contentType: file.mimetype },
  });

  await fileRef.makePublic();

  const bucketName  = bucket.name;
  const encodedPath = encodeURIComponent(mediaPath);
  const mediaUrl    = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media`;

  return { mediaUrl, mediaPath };
}

// ─── Delete a file from Firebase Storage (best-effort) ───────────────────────
async function deleteMediaFromFirebase(mediaPath) {
  if (!admin.apps.length || !mediaPath) return;
  try {
    await admin.storage().bucket().file(mediaPath).delete();
  } catch (_) {}
}

// ─── Classify MIME type → "image" | "audio" | "video" ────────────────────────
function classifyMime(mimeType) {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return "image";
  if (ALLOWED_AUDIO_TYPES.includes(mimeType)) return "audio";
  return "video";
}

// ─── Factory: receives io for real-time events ───────────────────────────────
export default function createPostRoutes(io) {
  const router = express.Router();

  // ── GET /api/posts/categories ──────────────────────────────────────────────
  router.get("/categories", (_, res) => {
    res.json({ categories: POST_CATEGORIES });
  });

  // ── POST /api/posts ────────────────────────────────────────────────────────
  // Accepts multipart OR JSON.
  //
  // Multipart fields:
  //   userId, userName, userRole, title, category, description
  //   media[]          — up to 5 files (image / audio / video)
  //
  // JSON body (pre-uploaded from client):
  //   ...same scalar fields...
  //   mediaUrl         — single pre-uploaded URL (legacy)
  //   mediaType        — "image" | "audio" | "video"
  //   mediaItems       — JSON string: [{type, url, size}] (new, multi-media)
  router.post("/", upload.array("media", 5), async (req, res) => {
    try {
      const { userId, userName, userRole, title, category, description } = req.body;

      if (!userId || !title || !category) {
        return res.status(400).json({ message: "userId, title, and category are required" });
      }

      if (!POST_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: "Invalid category", validCategories: POST_CATEGORIES });
      }

      const mediaItems = [];

      // ── 1. Handle pre-uploaded mediaItems array (from Flutter direct upload) ─
      if (req.body.mediaItems) {
        let parsed;
        try {
          parsed = typeof req.body.mediaItems === "string"
            ? JSON.parse(req.body.mediaItems)
            : req.body.mediaItems;
        } catch {
          return res.status(400).json({ message: "Invalid mediaItems JSON" });
        }
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.url && ["image", "audio", "video"].includes(item.type)) {
              mediaItems.push({
                type:     item.type,
                url:      item.url,
                path:     item.path || null,
                size:     item.size || 0,
                mimeType: item.mimeType || "",
              });
            }
          }
        }
      }

      // ── 2. Handle legacy single pre-uploaded URL ──────────────────────────
      if (req.body.mediaUrl && mediaItems.length === 0) {
        const mType = req.body.mediaType || "image";
        if (["image", "audio", "video"].includes(mType)) {
          mediaItems.push({ type: mType, url: req.body.mediaUrl });
        }
      }

      // ── 3. Handle multipart file uploads → Firebase Storage ───────────────
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const mType = classifyMime(file.mimetype);
          const maxBytes = mType === "image" ? IMAGE_MAX_BYTES
                         : mType === "audio" ? AUDIO_MAX_BYTES
                         : VIDEO_MAX_BYTES;

          if (file.size > maxBytes) {
            const label = mType.charAt(0).toUpperCase() + mType.slice(1);
            return res.status(400).json({
              message: `${label} file too large. Maximum allowed: ${maxBytes / 1024 / 1024} MB`,
            });
          }

          const { mediaUrl, mediaPath } = await uploadMediaToFirebase(file, userId);
          mediaItems.push({
            type:     mType,
            url:      mediaUrl,
            path:     mediaPath,
            size:     file.size,
            mimeType: file.mimetype,
          });
        }
      }

      // ── Derive backwards-compat single-media fields from first item ────────
      const firstItem   = mediaItems[0];
      const mediaType   = firstItem ? firstItem.type : "none";
      const mediaUrl    = firstItem ? firstItem.url  : null;
      const mediaPath   = firstItem ? (firstItem.path || null) : null;

      const post = await Post.create({
        userId,
        userName:    userName || "Anonymous",
        userRole:    userRole || "student",
        title:       title.trim(),
        category,
        description: (description || "").trim(),
        mediaType,
        mediaUrl,
        mediaPath,
        mediaItems,
        status: "pending",
      });

      io.emit("new_post_submitted", {
        postId:    post._id,
        title:     post.title,
        category:  post.category,
        userId:    post.userId,
        userName:  post.userName,
        userRole:  post.userRole,
        mediaItems: post.mediaItems,
      });

      res.status(201).json({
        message: "Post submitted for review. It will be visible once approved by admin.",
        post: {
          _id:        post._id,
          title:      post.title,
          category:   post.category,
          status:     post.status,
          mediaType:  post.mediaType,
          mediaItems: post.mediaItems,
          createdAt:  post.createdAt,
        },
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/explore ─────────────────────────────────────────────────
  router.get("/explore", async (req, res) => {
    try {
      const page     = Math.max(1, parseInt(req.query.page) || 1);
      const limit    = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const skip     = (page - 1) * limit;
      const category = req.query.category;

      const filter = { status: "approved" };
      if (category && POST_CATEGORIES.includes(category)) {
        filter.category = category;
      }

      const [posts, total] = await Promise.all([
        Post.find(filter)
          .sort({ approvedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select("-mediaPath -adminComment -rejectedBy -rejectedAt -approvedBy")
          .lean(),
        Post.countDocuments(filter),
      ]);

      const serialized = posts.map(p => ({
        ...p,
        likeCount:    (p.likes    || []).length,
        dislikeCount: (p.dislikes || []).length,
      }));

      res.json({
        posts: serialized,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/my/:userId ──────────────────────────────────────────────
  router.get("/my/:userId", async (req, res) => {
    try {
      const page  = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const skip  = (page - 1) * limit;

      const filter = { userId: req.params.userId };
      if (req.query.status) filter.status = req.query.status;

      const [posts, total] = await Promise.all([
        Post.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select("-mediaPath -approvedBy -rejectedBy")
          .lean(),
        Post.countDocuments(filter),
      ]);

      res.json({
        posts: posts.map(p => ({
          ...p,
          likeCount:    (p.likes    || []).length,
          dislikeCount: (p.dislikes || []).length,
        })),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/:id ─────────────────────────────────────────────────────
  router.get("/:id", async (req, res) => {
    try {
      const post = await Post.findById(req.params.id)
        .select("-mediaPath -approvedBy -rejectedBy")
        .lean();
      if (!post) return res.status(404).json({ message: "Post not found" });

      Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

      res.json({
        post: {
          ...post,
          likeCount:    (post.likes    || []).length,
          dislikeCount: (post.dislikes || []).length,
        },
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/posts/:id/like ───────────────────────────────────────────────
  router.post("/:id/like", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.status !== "approved") {
        return res.status(403).json({ message: "Cannot like a post that is not approved" });
      }

      const alreadyLiked    = post.likes.includes(userId);
      const alreadyDisliked = post.dislikes.includes(userId);

      const update = alreadyLiked
        ? { $pull: { likes: userId } }
        : { $addToSet: { likes: userId } };

      // Remove dislike when liking
      if (!alreadyLiked && alreadyDisliked) {
        update.$pull = { ...(update.$pull || {}), dislikes: userId };
      }

      const updated     = await Post.findByIdAndUpdate(req.params.id, update, { new: true });
      const likeCount   = updated.likes.length;
      const dislikeCount = updated.dislikes.length;

      syncPostEngagementToRTDB(req.params.id, likeCount).catch(() => {});

      io.emit("post_engagement_updated", {
        postId: req.params.id, likeCount, dislikeCount,
        liked:  !alreadyLiked,
        userId,
      });

      res.json({
        liked:        !alreadyLiked,
        disliked:     false,
        likeCount,
        dislikeCount,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/posts/:id/dislike ────────────────────────────────────────────
  router.post("/:id/dislike", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.status !== "approved") {
        return res.status(403).json({ message: "Cannot dislike a post that is not approved" });
      }

      const alreadyDisliked = post.dislikes.includes(userId);
      const alreadyLiked    = post.likes.includes(userId);

      const update = alreadyDisliked
        ? { $pull: { dislikes: userId } }
        : { $addToSet: { dislikes: userId } };

      // Remove like when disliking
      if (!alreadyDisliked && alreadyLiked) {
        update.$pull = { ...(update.$pull || {}), likes: userId };
      }

      const updated      = await Post.findByIdAndUpdate(req.params.id, update, { new: true });
      const likeCount    = updated.likes.length;
      const dislikeCount = updated.dislikes.length;

      io.emit("post_engagement_updated", {
        postId: req.params.id, likeCount, dislikeCount,
        disliked: !alreadyDisliked,
        userId,
      });

      res.json({
        disliked:    !alreadyDisliked,
        liked:       false,
        likeCount,
        dislikeCount,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/:id/comments ───────────────────────────────────────────
  router.get("/:id/comments", async (req, res) => {
    try {
      const page  = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const skip  = (page - 1) * limit;

      const [comments, total] = await Promise.all([
        PostComment.find({ postId: req.params.id })
          .sort({ createdAt: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        PostComment.countDocuments({ postId: req.params.id }),
      ]);

      res.json({ comments, total, page });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/posts/:id/comments ──────────────────────────────────────────
  router.post("/:id/comments", async (req, res) => {
    const { userId, userName, userRole, text } = req.body;
    if (!userId || !text?.trim()) {
      return res.status(400).json({ message: "userId and text are required" });
    }

    try {
      const post = await Post.findById(req.params.id).select("status").lean();
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.status !== "approved") {
        return res.status(403).json({ message: "Cannot comment on an unapproved post" });
      }

      const comment = await PostComment.create({
        postId:     req.params.id,
        authorId:   userId,
        authorName: userName || "Anonymous",
        authorRole: userRole || "student",
        text:       text.trim(),
      });

      io.emit("post_comment_added", {
        postId:  req.params.id,
        comment: {
          _id:        comment._id,
          authorName: comment.authorName,
          authorRole: comment.authorRole,
          text:       comment.text,
          likes:      [],
          likeCount:  0,
          createdAt:  comment.createdAt,
        },
      });

      res.status(201).json({ comment });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── DELETE /api/posts/:id ──────────────────────────────────────────────────
  router.delete("/:id", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.userId !== userId) return res.status(403).json({ message: "Forbidden" });

      // Delete all media items from Firebase Storage
      for (const item of post.mediaItems || []) {
        if (item.path) await deleteMediaFromFirebase(item.path);
      }
      if (post.mediaPath && !(post.mediaItems || []).some(i => i.path === post.mediaPath)) {
        await deleteMediaFromFirebase(post.mediaPath);
      }

      if (post.status === "approved") {
        removePostFromRTDB(req.params.id).catch(() => {});
      }

      await PostComment.deleteMany({ postId: req.params.id });
      await Post.findByIdAndDelete(req.params.id);

      res.json({ message: "Post deleted" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

// ─── Shared helper: notify a user their post was approved/rejected ────────────
export async function notifyPostAuthor(io, { recipientUid, recipientRole = "student", type, title, body, data = {} }) {
  const notification = await Notification.create({
    recipientUid,
    recipientRole,
    type,
    title,
    body,
    data,
  });

  io.to(`${recipientRole}:${recipientUid}`).emit("new_notification", {
    _id:       notification._id,
    type,
    title,
    body,
    data,
    read:      false,
    createdAt: notification.createdAt,
  });

  syncNotificationToRTDB(recipientUid, String(notification._id), {
    type, title, body, data,
    createdAt: notification.createdAt.getTime(),
    read: false,
  });

  try {
    const tokenRecord = await FCMToken.findOne({ userUid: recipientUid }).lean();
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
      await FCMToken.deleteOne({ userUid: recipientUid });
    }
  }
}
