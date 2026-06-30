import "dotenv/config";
import express from "express";
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
import notificationRoutes from "./routes/notificationRoutes.js";
import otpRoutes from "./routes/otpRoutes.js";
import createSoulteeApplicationRoutes from "./routes/soulteeApplicationRoutes.js";
import SystemSettings from "./models/SystemSettings.js";
import SubscriptionPlan from "./models/SubscriptionPlan.js";
import "./config/firebase.js"; // initialise Firebase Admin on startup
import analyticsRoutes from "./routes/analyticsRoutes.js";
import securityRoutes from "./routes/securityRoutes.js";
import marketingRoutes from "./routes/marketingRoutes.js";
import supportRoutes from "./routes/supportRoutes.js";
import createPostRoutes from "./routes/postRoutes.js";
import emotionalPrescriptionRoutes from "./routes/emotionalPrescriptionRoutes.js";
import soulMeterRoutes from "./routes/soulMeterRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import subscriptionRoutes from "./routes/subscriptionRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import featureSubscriptionRoutes from "./routes/featureSubscriptionRoutes.js";
import { runSubscriptionExpiryJob } from "./services/subscriptionExpiryService.js";
import { runFeatureExpiryJob } from "./services/featureExpiryService.js";
import createFollowUpRoutes from "./routes/followUpRoutes.js";
import { runFollowUpExpiryJob } from "./services/followUpExpiryService.js";
import userRoutes from "./routes/userRoutes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
let isAppReady = false;

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

// ─── REST Routes ──────────────────────────────────────────────────────────────
app.use("/api/souljar",           souljarRoutes);
app.use("/api/soultees",          soulteeRoutes);
app.use("/api/admin",             adminRoutes);
app.use("/api/settings",          settingsRoutes);
app.use("/api/soulpana",          createSoulpanaRoutes());
app.use("/api/soultee-dashboard", createSoulteeDashboardRoutes());
app.use("/api/notifications",         notificationRoutes);
app.use("/api/otp",                   otpRoutes);
app.use("/api/soultee-application",   createSoulteeApplicationRoutes());
app.use("/api/analytics",             analyticsRoutes);
app.use("/api/security",              securityRoutes);
app.use("/api/marketing",             marketingRoutes);
app.use("/api/support",               supportRoutes);
app.use("/api/posts",                 createPostRoutes());
app.use("/api/emotional-prescription", emotionalPrescriptionRoutes);
app.use("/api/soulmeter",            soulMeterRoutes);
app.use("/api/auth",                 authRoutes);
app.use("/api/subscriptions",         subscriptionRoutes);
app.use("/api/payments",              paymentRoutes);
app.use("/api/feature-subscriptions", featureSubscriptionRoutes);
app.use("/api/follow-up",             createFollowUpRoutes());
app.use("/api/users",                 userRoutes);
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

async function bootstrapApp() {
  await connectDB();
  await SystemSettings.ensureDefaults();
  await SubscriptionPlan.ensureDefaults();
  isAppReady = true;

  // Run subscription expiry job immediately on startup, then every 6 hours
  runSubscriptionExpiryJob();
  setInterval(runSubscriptionExpiryJob, 6 * 60 * 60 * 1000);

  // Feature subscription expiry + notifications: immediately, then every 12 hours
  runFeatureExpiryJob();
  setInterval(runFeatureExpiryJob, 12 * 60 * 60 * 1000);

  // Follow-up OTP expiry: immediately on startup, then every 5 minutes
  runFollowUpExpiryJob();
  setInterval(() => runFollowUpExpiryJob(), 5 * 60 * 1000);

  console.log("Application bootstrap completed.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT} (bootstrap in progress)`);
});

bootstrapApp().catch((error) => {
  console.error("Bootstrap failed:", error.message);
});
