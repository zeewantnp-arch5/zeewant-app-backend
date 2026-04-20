import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
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
import "./config/firebase.js"; // initialise Firebase Admin on startup
import { registerRealtimeServer, resetRealtimePresenceState } from "./sockets/realtimeServer.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import { registerAnalyticsNamespace } from "./sockets/analyticsNamespace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
registerRealtimeServer(io);
registerAnalyticsNamespace(io);

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

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
app.use(express.static(join(__dirname, "public")));
app.use("/uploads", express.static(join(__dirname, "uploads")));

app.get("/", (req, res) => res.send("Zeewant Backend Running..."));

const PORT = process.env.PORT || 5000;

async function startServer() {
  await connectDB();
  await SystemSettings.ensureDefaults();
  await resetRealtimePresenceState();

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
