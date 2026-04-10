import express from "express";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import Souljar from "../models/souljar.js";
import Soulpana from "../models/Soulpana.js";

// Factory: accepts the Socket.io instance so routes can emit real-time events
export default function createSoulteeDashboardRoutes(io) {
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  STUDENT — get all my requests (to know status per soultee)
//  GET /api/soultee-dashboard/my-requests/:studentUid
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my-requests/:studentUid", async (req, res) => {
  try {
    const links = await StudentSoulteeLink.find({
      studentFirebaseUid: req.params.studentUid,
    })
      .select("soulteeFirebaseUid soulteeMongoId status requestedAt acceptedAt _id")
      .lean();
    res.json({ requests: links });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SOULTEE REGISTRATION / PROFILE SYNC
//  Called when a soultee logs in via Firebase for the first time
//  POST /api/soultee-dashboard/register
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { firebaseUid, name, gender, specialization, experienceYears, languages, bio } = req.body;
    if (!firebaseUid || !name) {
      return res.status(400).json({ message: "firebaseUid and name are required" });
    }

    // Upsert — create if not exists, update if already registered
    const soultee = await Soultee.findOneAndUpdate(
      { firebaseUid },
      { firebaseUid, name, gender, specialization, experienceYears, languages, bio },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ soultee });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SOULTEE ONLINE/OFFLINE STATUS
//  PATCH /api/soultee-dashboard/:soulteeUid/status
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:soulteeUid/status", async (req, res) => {
  try {
    const { status } = req.body; // online | offline | busy
    if (!["online", "offline", "busy"].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Use: online, offline, busy" });
    }

    const soultee = await Soultee.findOneAndUpdate(
      { firebaseUid: req.params.soulteeUid },
      { status },
      { new: true }
    );

    if (!soultee) return res.status(404).json({ message: "Soultee not found" });
    res.json({ status: soultee.status });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SOULTEE DASHBOARD STATS
//  GET /api/soultee-dashboard/:soulteeUid/stats
//  Returns counts for the soultee's dashboard header cards
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:soulteeUid/stats", async (req, res) => {
  try {
    const { soulteeUid } = req.params;

    const [activeStudents, pendingRequests, todaySessions, upcomingSessions] =
      await Promise.all([
        StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "active" }),
        StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "pending" }),
        Session.countDocuments({
          soulteeFirebaseUid: soulteeUid,
          status: { $in: ["upcoming", "ongoing"] },
          scheduledAt: {
            $gte: new Date(new Date().setHours(0, 0, 0, 0)),
            $lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        }),
        Session.countDocuments({
          soulteeFirebaseUid: soulteeUid,
          status: "upcoming",
          scheduledAt: { $gte: new Date() },
        }),
      ]);

    res.json({
      activeStudents,
      pendingRequests,
      todaySessions,
      upcomingSessions,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  STUDENT → SOULTEE REQUEST
//  Student sends a request to be linked with a soultee
//  POST /api/soultee-dashboard/request
// ─────────────────────────────────────────────────────────────────────────────
router.post("/request", async (req, res) => {
  try {
    const { studentFirebaseUid, studentName, soulteeFirebaseUid, requestMessage } = req.body;
    if (!studentFirebaseUid || !soulteeFirebaseUid) {
      return res.status(400).json({ message: "studentFirebaseUid and soulteeFirebaseUid are required" });
    }

    // Check soultee exists
    const soultee = await Soultee.findOne({ firebaseUid: soulteeFirebaseUid });
    if (!soultee) return res.status(404).json({ message: "Soultee not found" });

    // Check if link already exists
    const existing = await StudentSoulteeLink.findOne({
      studentFirebaseUid,
      soulteeFirebaseUid,
    });

    if (existing) {
      if (existing.status === "active") {
        return res.status(409).json({ message: "Already linked with this soultee" });
      }
      if (existing.status === "pending") {
        return res.status(409).json({ message: "Request already sent, waiting for acceptance" });
      }
      // If ended or declined, allow re-request
      existing.status = "pending";
      existing.requestMessage = requestMessage || "";
      existing.requestedAt = new Date();
      existing.acceptedAt = undefined;
      existing.endedAt = undefined;
      await existing.save();

      io.to(`soultee:${soulteeFirebaseUid}`).emit("new_connection_request", {
        linkId: existing._id,
        studentFirebaseUid,
        studentName: studentName || "Student",
        requestMessage: requestMessage || "",
        requestedAt: existing.requestedAt,
      });

      return res.status(200).json({ message: "Re-request sent successfully", link: existing });
    }

    const link = await StudentSoulteeLink.create({
      studentFirebaseUid,
      studentName: studentName || "Student",
      soulteeFirebaseUid,
      soulteeMongoId: soultee._id,
      requestMessage: requestMessage || "",
    });

    // Notify the soultee in real-time (whether online or offline — queued when they reconnect)
    io.to(`soultee:${soulteeFirebaseUid}`).emit("new_connection_request", {
      linkId: link._id,
      studentFirebaseUid,
      studentName: studentName || "Student",
      requestMessage: requestMessage || "",
      requestedAt: link.requestedAt,
    });

    res.status(201).json({ message: "Request sent successfully", link });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET PENDING REQUESTS FOR A SOULTEE
//  GET /api/soultee-dashboard/:soulteeUid/requests
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:soulteeUid/requests", async (req, res) => {
  try {
    const requests = await StudentSoulteeLink.find({
      soulteeFirebaseUid: req.params.soulteeUid,
      status: "pending",
    }).sort({ requestedAt: -1 });

    res.json({ requests, total: requests.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ACCEPT / DECLINE STUDENT REQUEST
//  PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/accept
//  PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/decline
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:soulteeUid/requests/:studentUid/accept", async (req, res) => {
  try {
    const { soulteeUid, studentUid } = req.params;

    const link = await StudentSoulteeLink.findOneAndUpdate(
      { soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid, status: "pending" },
      { status: "active", acceptedAt: new Date() },
      { new: true }
    );

    if (!link) return res.status(404).json({ message: "Pending request not found" });

    // Fetch soultee name to include in the notification
    const soultee = await Soultee.findOne({ firebaseUid: soulteeUid }).select("name profileImage").lean();

    // Notify the student in real-time
    io.to(`student:${studentUid}`).emit("connection_accepted", {
      linkId: link._id,
      soulteeFirebaseUid: soulteeUid,
      roomId: link._id.toString(),
      solteeName: soultee?.name || "Your Soultee",
      soulteeProfileImage: soultee?.profileImage || null,
      acceptedAt: link.acceptedAt,
    });

    res.json({ message: "Student accepted", link });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch("/:soulteeUid/requests/:studentUid/decline", async (req, res) => {
  try {
    const { soulteeUid, studentUid } = req.params;

    const link = await StudentSoulteeLink.findOneAndUpdate(
      { soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid, status: "pending" },
      { status: "declined" },
      { new: true }
    );

    if (!link) return res.status(404).json({ message: "Pending request not found" });

    const soultee = await Soultee.findOne({ firebaseUid: soulteeUid }).select("name").lean();

    // Notify the student in real-time
    io.to(`student:${studentUid}`).emit("connection_declined", {
      linkId: link._id,
      soulteeFirebaseUid: soulteeUid,
      solteeName: soultee?.name || "Your Soultee",
    });

    res.json({ message: "Request declined", link });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET ALL ACTIVE STUDENTS FOR A SOULTEE (with latest activity)
//  GET /api/soultee-dashboard/:soulteeUid/students
//  This is the main "real-time" list — poll this or use SSE below
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:soulteeUid/students", async (req, res) => {
  try {
    const links = await StudentSoulteeLink.find({
      soulteeFirebaseUid: req.params.soulteeUid,
      status: "active",
    }).sort({ acceptedAt: -1 });

    // For each student, get their latest souljar entry and soulpana question
    const students = await Promise.all(
      links.map(async (link) => {
        const [latestEntry, latestQuestion, totalEntries, recentMoods] = await Promise.all([
          Souljar.findOne({ userId: link.studentFirebaseUid })
            .sort({ createdAt: -1 })
            .select("mood topic stamp createdAt text")
            .lean(),
          Soulpana.findOne({ userId: link.studentFirebaseUid })
            .sort({ createdAt: -1 })
            .select("title category status createdAt")
            .lean(),
          Souljar.countDocuments({ userId: link.studentFirebaseUid }),
          // Last 7 days mood trend
          Souljar.find({
            userId: link.studentFirebaseUid,
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          })
            .sort({ createdAt: -1 })
            .select("mood createdAt")
            .lean(),
        ]);

        return {
          studentFirebaseUid: link.studentFirebaseUid,
          studentName: link.studentName,
          linkedSince: link.acceptedAt,
          latestMood: latestEntry?.mood || null,
          latestEntryAt: latestEntry?.createdAt || null,
          latestTopic: latestEntry?.topic || null,
          latestStamp: latestEntry?.stamp || null,
          totalEntries,
          recentMoods: recentMoods.map((e) => ({ mood: e.mood, at: e.createdAt })),
          latestQuestion: latestQuestion
            ? { title: latestQuestion.title, status: latestQuestion.status, at: latestQuestion.createdAt }
            : null,
        };
      })
    );

    res.json({ students, total: students.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET A SPECIFIC STUDENT'S FULL DASHBOARD DATA
//  GET /api/soultee-dashboard/:soulteeUid/students/:studentUid
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:soulteeUid/students/:studentUid", async (req, res) => {
  try {
    const { soulteeUid, studentUid } = req.params;

    // Verify student is actually linked to this soultee
    const link = await StudentSoulteeLink.findOne({
      soulteeFirebaseUid: soulteeUid,
      studentFirebaseUid: studentUid,
      status: "active",
    });
    if (!link) return res.status(403).json({ message: "Student not linked to this soultee" });

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const [souljarEntries, soulpanaQuestions, sessions, moodDistribution] = await Promise.all([
      // Recent souljar entries
      Souljar.find({ userId: studentUid })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("mood topic stamp text jarCode createdAt wordCount")
        .lean(),

      // All soulpana questions from this student
      Soulpana.find({ userId: studentUid })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("title category soulteeType status createdAt")
        .lean(),

      // Sessions between this soultee and student
      Session.find({ soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid })
        .sort({ scheduledAt: -1 })
        .limit(10)
        .lean(),

      // Mood distribution (all time)
      Souljar.aggregate([
        { $match: { userId: studentUid } },
        { $group: { _id: "$mood", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    res.json({
      student: {
        firebaseUid: studentUid,
        name: link.studentName,
        linkedSince: link.acceptedAt,
      },
      souljarEntries,
      soulpanaQuestions,
      sessions,
      moodDistribution: Object.fromEntries(
        moodDistribution.map((m) => [m._id || "None", m.count])
      ),
      totalEntries: souljarEntries.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  END / UNLINK A STUDENT
//  PATCH /api/soultee-dashboard/:soulteeUid/students/:studentUid/end
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:soulteeUid/students/:studentUid/end", async (req, res) => {
  try {
    const link = await StudentSoulteeLink.findOneAndUpdate(
      {
        soulteeFirebaseUid: req.params.soulteeUid,
        studentFirebaseUid: req.params.studentUid,
        status: "active",
      },
      { status: "ended", endedAt: new Date() },
      { new: true }
    );

    if (!link) return res.status(404).json({ message: "Active link not found" });
    res.json({ message: "Student unlinked", link });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SESSIONS — CRUD
// ─────────────────────────────────────────────────────────────────────────────

// Create a session
// POST /api/soultee-dashboard/:soulteeUid/sessions
router.post("/:soulteeUid/sessions", async (req, res) => {
  try {
    const { studentFirebaseUid, studentName, scheduledAt, durationMinutes, sessionType } = req.body;
    if (!studentFirebaseUid || !scheduledAt) {
      return res.status(400).json({ message: "studentFirebaseUid and scheduledAt are required" });
    }

    const session = await Session.create({
      soulteeFirebaseUid: req.params.soulteeUid,
      studentFirebaseUid,
      studentName: studentName || "Student",
      scheduledAt: new Date(scheduledAt),
      durationMinutes: durationMinutes || 60,
      sessionType: sessionType || "chat",
    });

    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all sessions for a soultee
// GET /api/soultee-dashboard/:soulteeUid/sessions
router.get("/:soulteeUid/sessions", async (req, res) => {
  try {
    const filter = { soulteeFirebaseUid: req.params.soulteeUid };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.studentUid) filter.studentFirebaseUid = req.query.studentUid;

    const sessions = await Session.find(filter)
      .sort({ scheduledAt: -1 })
      .limit(50)
      .lean();

    res.json({ sessions, total: sessions.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update session status or notes
// PATCH /api/soultee-dashboard/:soulteeUid/sessions/:sessionId
router.patch("/:soulteeUid/sessions/:sessionId", async (req, res) => {
  try {
    const { status, notes, cancelReason } = req.body;
    const update = {};
    if (status) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (cancelReason) update.cancelReason = cancelReason;

    const session = await Session.findOneAndUpdate(
      { _id: req.params.sessionId, soulteeFirebaseUid: req.params.soulteeUid },
      update,
      { new: true }
    );

    if (!session) return res.status(404).json({ message: "Session not found" });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  REAL-TIME SSE — Live student updates stream
//  GET /api/soultee-dashboard/:soulteeUid/live
//  Flutter polls every 10s OR use this SSE endpoint for push updates
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:soulteeUid/live", async (req, res) => {
  const { soulteeUid } = req.params;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendUpdate = async () => {
    try {
      const [pendingRequests, activeStudents, todaySessions] = await Promise.all([
        StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "pending" }),
        StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "active" }),
        Session.countDocuments({
          soulteeFirebaseUid: soulteeUid,
          status: { $in: ["upcoming", "ongoing"] },
          scheduledAt: {
            $gte: new Date(new Date().setHours(0, 0, 0, 0)),
            $lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        }),
      ]);

      const data = JSON.stringify({ pendingRequests, activeStudents, todaySessions, ts: new Date() });
      res.write(`data: ${data}\n\n`);
    } catch {
      // ignore transient errors in SSE
    }
  };

  // Send immediately + every 10 seconds
  await sendUpdate();
  const interval = setInterval(sendUpdate, 10000);

  // Clean up on client disconnect
  req.on("close", () => clearInterval(interval));
});

  return router;
} // end createSoulteeDashboardRoutes
