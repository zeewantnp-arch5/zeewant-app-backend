import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import connectDB from "./config/db.js";
import soulteeRoutes from "./routes/soulteeRoutes.js";
import souljarRoutes from "./routes/souljarRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import createSoulpanaRoutes from "./routes/soulpanaRoutes.js";
import createSoulteeDashboardRoutes from "./routes/soulteeDashboardRoutes.js";
import createChatRoutes from "./routes/chatRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import otpRoutes from "./routes/otpRoutes.js";
import createSoulteeApplicationRoutes from "./routes/soulteeApplicationRoutes.js";
import SystemSettings from "./models/SystemSettings.js";
import SubscriptionPlan from "./models/SubscriptionPlan.js";
import "./config/firebase.js"; // initialise Firebase Admin on startup
import { registerRealtimeServer, resetRealtimePresenceState } from "./sockets/realtimeServer.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import { registerAnalyticsNamespace } from "./sockets/analyticsNamespace.js";
import securityRoutes from "./routes/securityRoutes.js";
import { registerSecurityNamespace } from "./sockets/securityNamespace.js";
import marketingRoutes from "./routes/marketingRoutes.js";
import { registerMarketingNamespace } from "./sockets/marketingNamespace.js";
import supportRoutes from "./routes/supportRoutes.js";
import createPostRoutes from "./routes/postRoutes.js";
import { registerSupportNamespace } from "./sockets/supportNamespace.js";
import emotionalPrescriptionRoutes from "./routes/emotionalPrescriptionRoutes.js";
import soulMeterRoutes from "./routes/soulMeterRoutes.js";
import callRoutes from "./routes/callRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import subscriptionRoutes from "./routes/subscriptionRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import featureSubscriptionRoutes from "./routes/featureSubscriptionRoutes.js";
import { runSubscriptionExpiryJob } from "./services/subscriptionExpiryService.js";
import { runFeatureExpiryJob } from "./services/featureExpiryService.js";
import createFollowUpRoutes from "./routes/followUpRoutes.js";
import { runFollowUpExpiryJob } from "./services/followUpExpiryService.js";
import userRoutes from "./routes/userRoutes.js";
import agoraChatRoutes from "./routes/agoraChatRoutes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
let isAppReady = false;

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Both transports: Flutter WebSocket-only clients skip polling entirely;
  // browser/older builds use polling→WS upgrade.
  transports: ["polling", "websocket"],
  // pingInterval: how often the server sends a heartbeat to the client.
  pingInterval: 10000,
  // pingTimeout: how long to wait for a pong before declaring the socket dead.
  // 10 s is aggressive enough to detect app crashes / network drops quickly
  // while still tolerating brief mobile network hiccups.
  pingTimeout: 10000,
  // upgradeTimeout: time allowed for the HTTP→WebSocket upgrade handshake.
  upgradeTimeout: 30000,
  // connectTimeout: maximum time for the initial connection handshake.
  connectTimeout: 45000,
  // Allow up to 10 MB payloads (image/file messages).
  maxHttpBufferSize: 1e7,
});
registerRealtimeServer(io);
registerAnalyticsNamespace(io);
registerSecurityNamespace(io);
registerMarketingNamespace(io);
registerSupportNamespace(io);

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Return a fast, explicit response while DB/bootstrap tasks are still running.
app.use("/api", (req, res, next) => {
  if (isAppReady) return next();
  res.status(503).json({
    success: false,
    message: "Server is warming up. Please retry shortly.",
  });
});

// Log requests that take longer than 3 s
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms > 3000) {
      console.warn(`[SLOW] ${req.method} ${req.path} — ${ms}ms (${_res.statusCode})`);
    }
  });
  next();
});

// ─── Expose io to route handlers (for admin application notifications) ────────
app.set("io", io);

// ─── REST Routes ──────────────────────────────────────────────────────────────
app.use("/api/souljar",           souljarRoutes);
app.use("/api/soultees",          soulteeRoutes);
app.use("/api/admin",             adminRoutes);
app.use("/api/settings",          settingsRoutes);
app.use("/api/soulpana",          createSoulpanaRoutes(io));
app.use("/api/soultee-dashboard", createSoulteeDashboardRoutes(io));
app.use("/api/chat",              createChatRoutes(io));
app.use("/api/notifications",         notificationRoutes);
app.use("/api/otp",                   otpRoutes);
app.use("/api/soultee-application",   createSoulteeApplicationRoutes(io));
app.use("/api/analytics",             analyticsRoutes);
app.use("/api/security",              securityRoutes);
app.use("/api/marketing",             marketingRoutes);
app.use("/api/support",               supportRoutes);
app.use("/api/posts",                 createPostRoutes(io));
app.use("/api/emotional-prescription", emotionalPrescriptionRoutes);
app.use("/api/soulmeter",            soulMeterRoutes);
app.use("/api/calls",                callRoutes);
app.use("/api/auth",                 authRoutes);
app.use("/api/subscriptions",         subscriptionRoutes);
app.use("/api/payments",              paymentRoutes);
app.use("/api/feature-subscriptions", featureSubscriptionRoutes);
app.use("/api/follow-up",             createFollowUpRoutes(io));
app.use("/api/users",                 userRoutes);
app.use("/api/agora-chat",            agoraChatRoutes);
app.use(express.static(join(__dirname, "public")));
app.use("/uploads", express.static(join(__dirname, "uploads")));

app.get("/", (req, res) => res.send("Zeewant Backend Running..."));
app.get("/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  res.json({
    status: "ok",
    ready: isAppReady,
    db: dbState === 1 ? "connected" : "degraded",
    ts: Date.now(),
  });
});

// Debug endpoint — shows masked env vars
app.get("/debug/env", (_req, res) => {
  const mask = (v) => v ? `${v.slice(0, 6)}...${v.slice(-4)} (len=${v.length})` : "NOT SET";
  res.json({
    KHALTI_BASE_URL:   process.env.KHALTI_BASE_URL  || "NOT SET",
    KHALTI_SECRET_KEY: mask(process.env.KHALTI_SECRET_KEY),
    BACKEND_URL:       process.env.BACKEND_URL       || "NOT SET",
    NODE_ENV:          process.env.NODE_ENV          || "NOT SET",
  });
});

const PORT = process.env.PORT || 5000;

function startHttpServer() {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${PORT} (bootstrap in progress)`);
  });
}

async function bootstrapApp() {
  await connectDB();
  await SystemSettings.ensureDefaults();
  await SubscriptionPlan.ensureDefaults();
  await resetRealtimePresenceState();
  isAppReady = true;

  // Run subscription expiry job immediately on startup, then every 6 hours
  runSubscriptionExpiryJob();
  setInterval(runSubscriptionExpiryJob, 6 * 60 * 60 * 1000);

  // Feature subscription expiry + notifications: immediately, then every 12 hours
  runFeatureExpiryJob();
  setInterval(runFeatureExpiryJob, 12 * 60 * 60 * 1000);

  // Follow-up OTP expiry: immediately on startup (catches missed expirations after
  // a server restart — the per-activation setTimeout is lost on restart)
  // then every 5 minutes
  runFollowUpExpiryJob(io);
  setInterval(() => runFollowUpExpiryJob(io), 5 * 60 * 1000);

  console.log("Application bootstrap completed.");
}

startHttpServer();
bootstrapApp().catch((error) => {
  console.error("Bootstrap failed:", error.message);
});
