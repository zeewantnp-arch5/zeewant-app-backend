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
import soulpanaRoutes from "./routes/soulpanaRoutes.js";
import soulteeDashboardRoutes from "./routes/soulteeDashboardRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import Message from "./models/Message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();
connectDB();

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ── Join a session room (roomId = StudentSoulteeLink _id) ──────────────────
  socket.on("join_room", ({ roomId, userId, userName }) => {
    socket.join(roomId);
    socket.data.userId   = userId;
    socket.data.userName = userName;
    socket.data.roomId   = roomId;
    console.log(`👥 ${userName} joined room ${roomId}`);
  });

  // ── Chat message ───────────────────────────────────────────────────────────
  socket.on("send_message", async ({ roomId, senderId, senderName, senderRole, text }) => {
    try {
      const msg = await Message.create({ roomId, senderId, senderName, senderRole, text });
      io.to(roomId).emit("new_message", {
        _id: msg._id,
        roomId,
        senderId,
        senderName,
        senderRole,
        text,
        createdAt: msg.createdAt,
      });
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  // ── Typing indicators ──────────────────────────────────────────────────────
  socket.on("typing",      ({ roomId, senderId }) => socket.to(roomId).emit("user_typing",      senderId));
  socket.on("stop_typing", ({ roomId, senderId }) => socket.to(roomId).emit("user_stop_typing", senderId));

  // ── WebRTC signaling — audio / video calls ─────────────────────────────────
  // Caller sends offer
  socket.on("call_offer", ({ roomId, offer, callType }) => {
    socket.to(roomId).emit("call_offer", { offer, callType, callerId: socket.data.userId });
  });

  // Callee sends answer
  socket.on("call_answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("call_answer", { answer });
  });

  // ICE candidates exchange
  socket.on("ice_candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice_candidate", { candidate });
  });

  // End call / reject call
  socket.on("end_call", ({ roomId }) => {
    io.to(roomId).emit("call_ended");
  });

  socket.on("reject_call", ({ roomId }) => {
    socket.to(roomId).emit("call_rejected");
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });
});

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── REST Routes ──────────────────────────────────────────────────────────────
app.use("/api/souljar",           souljarRoutes);
app.use("/api/soultees",          soulteeRoutes);
app.use("/api/admin",             adminRoutes);
app.use("/api/settings",          settingsRoutes);
app.use("/api/soulpana",          soulpanaRoutes);
app.use("/api/soultee-dashboard", soulteeDashboardRoutes);
app.use("/api/chat",              chatRoutes);
app.use(express.static(join(__dirname, "public")));

app.get("/", (req, res) => res.send("Zeewant Backend Running..."));

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
