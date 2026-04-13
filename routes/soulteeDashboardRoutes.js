import express from "express";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import Souljar from "../models/souljar.js";
import Soulpana from "../models/Soulpana.js";
import { getStudentConnections } from "../services/connectionService.js";
import {
  createPersistentMessage,
  getRoomMessageMetadata,
  getUnreadMessageSummary,
} from "../services/messageService.js";
import { createNotification, emitToUser } from "../services/notificationService.js";
import { syncProfileToRTDB } from "../config/firebase.js";

// ─────────────────────────────────────────────────────────────────────────────
//  Factory — receives io so every route handler can emit socket events
// ─────────────────────────────────────────────────────────────────────────────
export default function createSoulteeDashboardRoutes(io) {
  const router = express.Router();

  // ───────────────────────────────────────────────────────────────────────────
  //  STUDENT — get all accepted Soultee connections
  //  GET /api/soultee-dashboard/connections/:studentUid
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/connections/:studentUid", async (req, res) => {
    try {
      const connections = await getStudentConnections(req.params.studentUid);
      res.json({ connections, total: connections.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  STUDENT — get all my requests (status per soultee)
  //  GET /api/soultee-dashboard/my-requests/:studentUid
  // ───────────────────────────────────────────────────────────────────────────
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

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE REGISTRATION / PROFILE SYNC
  //  POST /api/soultee-dashboard/register
  // ───────────────────────────────────────────────────────────────────────────
  router.post("/register", async (req, res) => {
    try {
      const { firebaseUid, name, gender, specialization, experienceYears, languages, bio } = req.body;
      if (!firebaseUid || !name) {
        return res.status(400).json({ message: "firebaseUid and name are required" });
      }

      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid },
        { firebaseUid, name, gender, specialization, experienceYears, languages, bio },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Sync profile to Firebase RTDB for real-time reads
      syncProfileToRTDB(firebaseUid, {
        uid: firebaseUid,
        name,
        gender: gender || null,
        specialization: specialization || null,
        experienceYears: experienceYears || null,
        languages: languages || [],
        bio: bio || null,
        status: soultee.status,
        rating: soultee.rating,
        profileImage: soultee.profileImage || null,
        role: "soultee",
      });

      res.status(200).json({ soultee });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE ONLINE/OFFLINE STATUS
  //  PATCH /api/soultee-dashboard/:soulteeUid/status
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/status", async (req, res) => {
    try {
      const { status } = req.body;
      if (!["online", "offline", "busy"].includes(status)) {
        return res.status(400).json({ message: "Invalid status. Use: online, offline, busy" });
      }

      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid: req.params.soulteeUid },
        { status },
        { new: true }
      );

      if (!soultee) return res.status(404).json({ message: "Soultee not found" });

      // Sync status change to RTDB
      syncProfileToRTDB(req.params.soulteeUid, {
        uid: req.params.soulteeUid,
        name: soultee.name,
        status: soultee.status,
        role: "soultee",
      });

      res.json({ status: soultee.status });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE DASHBOARD STATS
  //  GET /api/soultee-dashboard/:soulteeUid/stats
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/stats", async (req, res) => {
    try {
      const { soulteeUid } = req.params;

      const [soultee, activeStudents, pendingRequests, todaySessions, upcomingSessions] =
        await Promise.all([
          Soultee.findOne({ firebaseUid: soulteeUid })
            .select("rating totalFeedbacks feePerSession")
            .lean(),
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

      const defaultSessionFee = Number(soultee?.feePerSession || 0);

      const [earningsSummary] = await Session.aggregate([
        {
          $match: {
            soulteeFirebaseUid: soulteeUid,
            status: { $in: ["upcoming", "ongoing", "completed"] },
          },
        },
        {
          $project: {
            status: 1,
            effectiveFee: {
              $ifNull: ["$sessionFee", defaultSessionFee],
            },
          },
        },
        {
          $group: {
            _id: null,
            completedSessions: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
              },
            },
            earningsReceived: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, "$effectiveFee", 0],
              },
            },
            earningsToBeReceived: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["upcoming", "ongoing"]] },
                  "$effectiveFee",
                  0,
                ],
              },
            },
          },
        },
      ]);

      const { totalUnreadMessages } = await getUnreadMessageSummary({
        userId: soulteeUid,
        userRole: "soultee",
      });

      const completedSessions = earningsSummary?.completedSessions ?? 0;
      const earningsReceived = earningsSummary?.earningsReceived ?? 0;
      const earningsToBeReceived = earningsSummary?.earningsToBeReceived ?? 0;

      res.json({
        completedSessions,
        activeStudents,
        pendingRequests,
        todaySessions,
        upcomingSessions,
        walletBalance: earningsReceived,
        earningsReceived,
        earningsToBeReceived,
        unreadMessages: totalUnreadMessages,
        rating: soultee?.rating ?? 0,
        totalFeedbacks: soultee?.totalFeedbacks ?? 0,
        notificationBadgeCount: pendingRequests + totalUnreadMessages,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  STUDENT → SOULTEE REQUEST
  //  POST /api/soultee-dashboard/request
  //  Body: { studentFirebaseUid, studentName, soulteeFirebaseUid, requestMessage }
  // ───────────────────────────────────────────────────────────────────────────
  router.post("/request", async (req, res) => {
    try {
      const { studentFirebaseUid, studentName, soulteeFirebaseUid, requestMessage } = req.body;
      if (!studentFirebaseUid || !soulteeFirebaseUid) {
        return res.status(400).json({ message: "studentFirebaseUid and soulteeFirebaseUid are required" });
      }

      const soultee = await Soultee.findOne({ firebaseUid: soulteeFirebaseUid });
      if (!soultee) return res.status(404).json({ message: "Soultee not found" });

      const existing = await StudentSoulteeLink.findOne({ studentFirebaseUid, soulteeFirebaseUid });

      let link;

      if (existing) {
        if (existing.status === "active") {
          return res.status(409).json({ message: "Already linked with this soultee" });
        }
        if (existing.status === "pending") {
          return res.status(409).json({ message: "Request already sent, waiting for acceptance" });
        }
        // ended or declined → allow re-request
        existing.status         = "pending";
        existing.requestMessage = requestMessage || "";
        existing.requestedAt    = new Date();
        existing.acceptedAt     = undefined;
        existing.endedAt        = undefined;
        await existing.save();
        link = existing;
      } else {
        link = await StudentSoulteeLink.create({
          studentFirebaseUid,
          studentName:    studentName || "Student",
          soulteeFirebaseUid,
          soulteeMongoId: soultee._id,
          requestMessage: requestMessage || "",
        });
      }

      if (String(requestMessage || "").trim()) {
        await createPersistentMessage({
          roomId: String(link._id),
          senderId: studentFirebaseUid,
          senderName: studentName || "Student",
          senderRole: "student",
          text: requestMessage,
          allowPending: true,
        });
      }

      // Real-time: tell the soultee a new request arrived (for request list update)
      io.to(`soultee:${soulteeFirebaseUid}`).emit("new_connection_request", {
        linkId:            link._id,
        studentFirebaseUid,
        studentName:       studentName || "Student",
        requestMessage:    requestMessage || "",
        requestedAt:       link.requestedAt,
      });

      // Persist notification + emit new_notification + FCM push
      await createNotification(io, {
        recipientUid:  soulteeFirebaseUid,
        recipientRole: "soultee",
        type:          "connection_request",
        title:         "New Connection Request",
        body:          `${studentName || "A student"} wants to connect with you`,
        data: {
          type:               "connection_request",
          linkId:             link._id.toString(),
          studentFirebaseUid,
          studentName:        studentName || "Student",
        },
      });

      const statusCode = existing ? 200 : 201;
      const message    = existing ? "Re-request sent successfully" : "Request sent successfully";
      res.status(statusCode).json({ message, link });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  GET PENDING REQUESTS FOR A SOULTEE
  //  GET /api/soultee-dashboard/:soulteeUid/requests
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/requests", async (req, res) => {
    try {
      const requests = await StudentSoulteeLink.find({
        soulteeFirebaseUid: req.params.soulteeUid,
        status: "pending",
      })
        .sort({ requestedAt: -1 })
        .lean();

      const metadataByRoom = await getRoomMessageMetadata({
        roomIds: requests.map((request) => String(request._id)),
        recipientUid: req.params.soulteeUid,
        recipientRole: "soultee",
      });

      const enrichedRequests = requests.map((request) => {
        const metadata = metadataByRoom.get(String(request._id)) || {};
        return {
          ...request,
          latestMessage: metadata.latestMessage || null,
          unreadMessageCount: metadata.unreadCount || 0,
        };
      });

      res.json({ requests: enrichedRequests, total: enrichedRequests.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  ACCEPT STUDENT REQUEST
  //  PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/accept
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/requests/:studentUid/accept", async (req, res) => {
    try {
      const { soulteeUid, studentUid } = req.params;

      const link = await StudentSoulteeLink.findOneAndUpdate(
        { soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid, status: "pending" },
        { status: "active", acceptedAt: new Date() },
        { new: true }
      );
      if (!link) return res.status(404).json({ message: "Pending request not found" });

      const soultee = await Soultee.findOne({ firebaseUid: soulteeUid })
        .select("name profileImage")
        .lean();

      const roomId = link._id.toString();

      // Real-time: tell the student their request was accepted (triggers UI update)
      const acceptedPayload = {
        linkId:             link._id,
        soulteeFirebaseUid: soulteeUid,
        roomId,
        soulteeName:        soultee?.name         || "Your Soultee",
        solteeName:         soultee?.name         || "Your Soultee",
        soulteeProfileImage: soultee?.profileImage || null,
        acceptedAt:         link.acceptedAt,
      };

      emitToUser(io, "student", studentUid, "connection_accepted", acceptedPayload);
      emitToUser(io, "student", studentUid, "connection_request_updated", {
        linkId: link._id,
        status: "active",
        roomId,
        soulteeFirebaseUid: soulteeUid,
      });
      emitToUser(io, "soultee", soulteeUid, "connection_request_updated", {
        linkId: link._id,
        status: "active",
        studentFirebaseUid: studentUid,
        roomId,
      });

      // Persist notification + emit new_notification + FCM push
      await createNotification(io, {
        recipientUid:  studentUid,
        recipientRole: "student",
        type:          "connection_accepted",
        title:         "Request Accepted!",
        body:          `${soultee?.name || "Your Soultee"} accepted your connection request`,
        data: {
          type:               "connection_accepted",
          linkId:             roomId,
          roomId,
          soulteeFirebaseUid: soulteeUid,
          soulteeName:        soultee?.name || "Your Soultee",
          solteeName:         soultee?.name || "Your Soultee",
        },
      });

      res.json({ message: "Student accepted", link });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  DECLINE STUDENT REQUEST
  //  PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/decline
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/requests/:studentUid/decline", async (req, res) => {
    try {
      const { soulteeUid, studentUid } = req.params;

      const link = await StudentSoulteeLink.findOneAndUpdate(
        { soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid, status: "pending" },
        { status: "declined" },
        { new: true }
      );
      if (!link) return res.status(404).json({ message: "Pending request not found" });

      const soultee = await Soultee.findOne({ firebaseUid: soulteeUid })
        .select("name")
        .lean();

      // Real-time: tell the student their request was declined
      const declinedPayload = {
        linkId:             link._id,
        soulteeFirebaseUid: soulteeUid,
        soulteeName:        soultee?.name || "Your Soultee",
        solteeName:         soultee?.name || "Your Soultee",
      };

      emitToUser(io, "student", studentUid, "connection_declined", declinedPayload);
      emitToUser(io, "student", studentUid, "connection_request_updated", {
        linkId: link._id,
        status: "declined",
        soulteeFirebaseUid: soulteeUid,
      });
      emitToUser(io, "soultee", soulteeUid, "connection_request_updated", {
        linkId: link._id,
        status: "declined",
        studentFirebaseUid: studentUid,
      });

      // Persist notification + emit new_notification + FCM push
      await createNotification(io, {
        recipientUid:  studentUid,
        recipientRole: "student",
        type:          "connection_declined",
        title:         "Connection Request Declined",
        body:          `${soultee?.name || "Your Soultee"} declined your request`,
        data: {
          type:               "connection_declined",
          linkId:             link._id.toString(),
          soulteeFirebaseUid: soulteeUid,
          soulteeName:        soultee?.name || "Your Soultee",
          solteeName:         soultee?.name || "Your Soultee",
        },
      });

      res.json({ message: "Request declined", link });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  GET ALL ACTIVE STUDENTS FOR A SOULTEE (with latest activity)
  //  GET /api/soultee-dashboard/:soulteeUid/students
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/students", async (req, res) => {
    try {
      const links = await StudentSoulteeLink.find({
        soulteeFirebaseUid: req.params.soulteeUid,
        status: "active",
      }).sort({ acceptedAt: -1 });

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
            Souljar.find({
              userId:    link.studentFirebaseUid,
              createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            })
              .sort({ createdAt: -1 })
              .select("mood createdAt")
              .lean(),
          ]);

          return {
            studentFirebaseUid: link.studentFirebaseUid,
            studentName:        link.studentName,
            roomId:             link._id.toString(),
            linkedSince:        link.acceptedAt,
            latestMood:         latestEntry?.mood       || null,
            latestEntryAt:      latestEntry?.createdAt  || null,
            latestTopic:        latestEntry?.topic      || null,
            latestStamp:        latestEntry?.stamp      || null,
            totalEntries,
            recentMoods:        recentMoods.map((e) => ({ mood: e.mood, at: e.createdAt })),
            latestQuestion:     latestQuestion
              ? { title: latestQuestion.title, status: latestQuestion.status, at: latestQuestion.createdAt }
              : null,
          };
        })
      );

      const metadataByRoom = await getRoomMessageMetadata({
        roomIds: students.map((student) => student.roomId),
        recipientUid: req.params.soulteeUid,
        recipientRole: "soultee",
      });

      const enrichedStudents = students.map((student) => {
        const metadata = metadataByRoom.get(student.roomId) || {};
        return {
          ...student,
          latestMessage: metadata.latestMessage || null,
          unreadMessageCount: metadata.unreadCount || 0,
        };
      });

      res.json({ students: enrichedStudents, total: enrichedStudents.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  GET A SPECIFIC STUDENT'S FULL DASHBOARD DATA
  //  GET /api/soultee-dashboard/:soulteeUid/students/:studentUid
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/students/:studentUid", async (req, res) => {
    try {
      const { soulteeUid, studentUid } = req.params;

      const link = await StudentSoulteeLink.findOne({
        soulteeFirebaseUid: soulteeUid,
        studentFirebaseUid: studentUid,
        status: "active",
      });
      if (!link) return res.status(403).json({ message: "Student not linked to this soultee" });

      const limit = Math.min(parseInt(req.query.limit) || 20, 100);

      const [souljarEntries, soulpanaQuestions, sessions, moodDistribution] = await Promise.all([
        Souljar.find({ userId: studentUid })
          .sort({ createdAt: -1 })
          .limit(limit)
          .select("mood topic stamp text jarCode createdAt wordCount")
          .lean(),
        Soulpana.find({ userId: studentUid })
          .sort({ createdAt: -1 })
          .limit(10)
          .select("title category soulteeType status createdAt")
          .lean(),
        Session.find({ soulteeFirebaseUid: soulteeUid, studentFirebaseUid: studentUid })
          .sort({ scheduledAt: -1 })
          .limit(10)
          .lean(),
        Souljar.aggregate([
          { $match: { userId: studentUid } },
          { $group: { _id: "$mood", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
      ]);

      res.json({
        student: {
          firebaseUid: studentUid,
          name:        link.studentName,
          linkedSince: link.acceptedAt,
          roomId:      link._id.toString(),
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

  // ───────────────────────────────────────────────────────────────────────────
  //  END / UNLINK A STUDENT
  //  PATCH /api/soultee-dashboard/:soulteeUid/students/:studentUid/end
  // ───────────────────────────────────────────────────────────────────────────
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

  // ───────────────────────────────────────────────────────────────────────────
  //  SESSIONS — CRUD
  // ───────────────────────────────────────────────────────────────────────────

  // Create a session
  // POST /api/soultee-dashboard/:soulteeUid/sessions
  router.post("/:soulteeUid/sessions", async (req, res) => {
    try {
      const { studentFirebaseUid, studentName, scheduledAt, durationMinutes, sessionType } = req.body;
      if (!studentFirebaseUid || !scheduledAt) {
        return res.status(400).json({ message: "studentFirebaseUid and scheduledAt are required" });
      }

      const soultee = await Soultee.findOne({ firebaseUid: req.params.soulteeUid })
        .select("name feePerSession")
        .lean();

      const session = await Session.create({
        soulteeFirebaseUid: req.params.soulteeUid,
        studentFirebaseUid,
        studentName:      studentName || "Student",
        scheduledAt:      new Date(scheduledAt),
        durationMinutes:  durationMinutes || 60,
        sessionType:      sessionType || "chat",
        sessionFee:       Number(soultee?.feePerSession || 0),
      });

      // Notify student about the scheduled session
      await createNotification(io, {
        recipientUid:  studentFirebaseUid,
        recipientRole: "student",
        type:          "session_scheduled",
        title:         "Session Scheduled",
        body:          `${soultee?.name || "Your Soultee"} scheduled a ${sessionType || "chat"} session`,
        data: {
          type:               "session_scheduled",
          sessionId:          session._id.toString(),
          sessionType:        sessionType || "chat",
          scheduledAt:        new Date(scheduledAt).toISOString(),
          soulteeFirebaseUid: req.params.soulteeUid,
        },
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
      if (req.query.status)     filter.status             = req.query.status;
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
      if (status)              update.status       = status;
      if (notes !== undefined) update.notes        = notes;
      if (cancelReason)        update.cancelReason = cancelReason;

      const session = await Session.findOneAndUpdate(
        { _id: req.params.sessionId, soulteeFirebaseUid: req.params.soulteeUid },
        update,
        { new: true }
      );

      if (!session) return res.status(404).json({ message: "Session not found" });

      // Notify student if session was cancelled
      if (status === "cancelled") {
        const soultee = await Soultee.findOne({ firebaseUid: req.params.soulteeUid })
          .select("name")
          .lean();

        await createNotification(io, {
          recipientUid:  session.studentFirebaseUid,
          recipientRole: "student",
          type:          "session_cancelled",
          title:         "Session Cancelled",
          body:          `${soultee?.name || "Your Soultee"} cancelled the session${cancelReason ? `: ${cancelReason}` : ""}`,
          data: {
            type:               "session_cancelled",
            sessionId:          session._id.toString(),
            soulteeFirebaseUid: req.params.soulteeUid,
          },
        });
      }

      res.json({ session });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SSE — Live dashboard stats stream (fallback for polling clients)
  //  GET /api/soultee-dashboard/:soulteeUid/live
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/live", async (req, res) => {
    const { soulteeUid } = req.params;

    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
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

        res.write(`data: ${JSON.stringify({ pendingRequests, activeStudents, todaySessions, ts: new Date() })}\n\n`);
      } catch {
        // ignore transient errors in SSE
      }
    };

    await sendUpdate();
    const interval = setInterval(sendUpdate, 10000);
    req.on("close", () => clearInterval(interval));
  });

  return router;
}
