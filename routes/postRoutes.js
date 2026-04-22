import express from "express";
import multer from "multer";
import Post, { POST_CATEGORIES } from "../models/Post.js";
import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";
import admin, {
  syncNotificationToRTDB,
  sendPushNotification,
  syncPostToRTDB,
  removePostFromRTDB,
  syncPostEngagementToRTDB,
} from "../config/firebase.js";

// ─── Multer: memory storage → stream to Firebase ────────────────────────────
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max (covers HD videos)
  fileFilter: (_, file, cb) => {
    if ([...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only images (JPEG/PNG/GIF/WebP/HEIC) and videos (MP4/MOV/AVI/WebM/MKV) are allowed"));
    }
  },
});

// ─── Upload a buffer to Firebase Storage, return { mediaUrl, mediaPath } ─────
async function uploadMediaToFirebase(file, userId) {
  if (!admin.apps.length) throw new Error("Firebase not initialised");

  const bucket    = admin.storage().bucket();
  const ext       = file.originalname.split(".").pop().toLowerCase();
  const timestamp = Date.now();
  const mediaPath = `posts/${userId}/${timestamp}.${ext}`;
  const fileRef   = bucket.file(mediaPath);

  await fileRef.save(file.buffer, {
    metadata: { contentType: file.mimetype },
  });

  // Make file publicly readable — no expiry, works in Flutter Web (no CORS issue)
  await fileRef.makePublic();

  const bucketName = bucket.name;
  const encodedPath = encodeURIComponent(mediaPath);
  const mediaUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media`;

  return { mediaUrl, mediaPath };
}

// ─── Delete a file from Firebase Storage (best-effort) ───────────────────────
async function deleteMediaFromFirebase(mediaPath) {
  if (!admin.apps.length || !mediaPath) return;
  try {
    await admin.storage().bucket().file(mediaPath).delete();
  } catch (_) {
    // File may already be deleted — not fatal
  }
}

// ─── Factory: receives io for real-time events ───────────────────────────────
export default function createPostRoutes(io) {
  const router = express.Router();

  // ── GET /api/posts/categories ────────────────────────────────────────────
  router.get("/categories", (_, res) => {
    res.json({ categories: POST_CATEGORIES });
  });

  // ── POST /api/posts ──────────────────────────────────────────────────────
  // Create a new post (multipart/form-data)
  // Fields: userId, userName, userRole, title, category, description
  // File:   media (optional — image or video)
  router.post("/", upload.single("media"), async (req, res) => {
    try {
      const { userId, userName, userRole, title, category, description } = req.body;

      if (!userId || !title || !category) {
        return res.status(400).json({ message: "userId, title, and category are required" });
      }

      if (!POST_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: "Invalid category", validCategories: POST_CATEGORIES });
      }

      let mediaType = "none";
      let mediaUrl  = null;
      let mediaPath = null;

      if (req.file) {
        // Multipart upload — backend handles Firebase upload
        mediaType = ALLOWED_IMAGE_TYPES.includes(req.file.mimetype) ? "image" : "video";
        const uploaded = await uploadMediaToFirebase(req.file, userId);
        mediaUrl  = uploaded.mediaUrl;
        mediaPath = uploaded.mediaPath;
      } else if (req.body.mediaUrl) {
        // Client-side Firebase upload — URL already set, just store it
        mediaUrl  = req.body.mediaUrl;
        mediaType = req.body.mediaType || "image";
      }

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
        status: "pending",
      });

      // Notify admin dashboard via socket
      io.emit("new_post_submitted", {
        postId:   post._id,
        title:    post.title,
        category: post.category,
        userId:   post.userId,
        userName: post.userName,
      });

      res.status(201).json({
        message: "Post submitted for review. It will be visible once approved by admin.",
        post: {
          _id:       post._id,
          title:     post.title,
          category:  post.category,
          status:    post.status,
          mediaType: post.mediaType,
          createdAt: post.createdAt,
        },
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/explore ───────────────────────────────────────────────
  // Approved posts for the student explore feed (paginated)
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

      // Attach likeCount
      const serialized = posts.map(p => ({
        ...p,
        likeCount: (p.likes || []).length,
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

  // ── GET /api/posts/my/:userId ────────────────────────────────────────────
  // User's own posts (all statuses)
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
        posts: posts.map(p => ({ ...p, likeCount: (p.likes || []).length })),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/posts/:id ───────────────────────────────────────────────────
  router.get("/:id", async (req, res) => {
    try {
      const post = await Post.findById(req.params.id)
        .select("-mediaPath -approvedBy -rejectedBy")
        .lean();
      if (!post) return res.status(404).json({ message: "Post not found" });

      // Increment view count (fire-and-forget)
      Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

      res.json({ post: { ...post, likeCount: (post.likes || []).length } });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/posts/:id/like ─────────────────────────────────────────────
  // Toggle like — body: { userId }
  router.post("/:id/like", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.status !== "approved") {
        return res.status(403).json({ message: "Cannot like a post that is not approved" });
      }

      const alreadyLiked = post.likes.includes(userId);
      const update = alreadyLiked
        ? { $pull:      { likes: userId } }
        : { $addToSet:  { likes: userId } };

      const updated = await Post.findByIdAndUpdate(req.params.id, update, { new: true });
      const likeCount = updated.likes.length;

      // Sync to RTDB for real-time badge updates
      syncPostEngagementToRTDB(req.params.id, likeCount).catch(() => {});

      // Emit to explore feed listeners
      io.emit("post_engagement_updated", {
        postId:    req.params.id,
        likeCount,
        liked:     !alreadyLiked,
        userId,
      });

      res.json({ liked: !alreadyLiked, likeCount });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── DELETE /api/posts/:id ────────────────────────────────────────────────
  // Allow post creator to delete their own pending/rejected post
  // Body: { userId }
  router.delete("/:id", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
      const post = await Post.findById(req.params.id);
      if (!post) return res.status(404).json({ message: "Post not found" });
      if (post.userId !== userId) return res.status(403).json({ message: "Forbidden" });

      await deleteMediaFromFirebase(post.mediaPath);
      await Post.findByIdAndDelete(req.params.id);

      if (post.status === "approved") {
        removePostFromRTDB(req.params.id).catch(() => {});
      }

      res.json({ message: "Post deleted" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}

// ─── Shared helper: notify a user their post was approved/rejected ────────────
// (called from adminRoutes.js)
export async function notifyPostAuthor(io, { recipientUid, type, title, body, data = {} }) {
  const notification = await Notification.create({
    recipientUid,
    recipientRole: "student",
    type,
    title,
    body,
    data,
  });

  io.to(`student:${recipientUid}`).emit("new_notification", {
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
    const tokenRecord = await FCMToken.findOne({ uid: recipientUid }).lean();
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
      await FCMToken.deleteOne({ uid: recipientUid });
    }
  }
}
