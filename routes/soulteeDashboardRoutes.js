import express from "express";
import Soultee from "../models/Soultee.js";
import SoulteeFeedback from "../models/SoulteeFeedback.js";
import admin from "../config/firebase.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import SessionWallet from "../models/SessionWallet.js";
import SessionWithdrawal from "../models/SessionWithdrawal.js";
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

const PLATFORM_COMMISSION_RATE = 10; // 10% platform fee

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
      if (!firebaseUid) {
        return res.status(400).json({ message: "firebaseUid is required" });
      }

      if (!admin.apps.length) {
        return res.status(500).json({ message: "Firebase not initialised" });
      }

      const userSnap = await admin.firestore().collection("users").doc(firebaseUid).get();
      const userData = userSnap.data() || {};
      const isApproved = (userData.soulteeStatus || "").toString().toLowerCase() === "active" &&
        userData.rolePending !== true;

      if (!isApproved) {
        return res.status(403).json({ message: "SOULTEE profile is not approved yet" });
      }

      const existingSoultee = await Soultee.findOne({ firebaseUid }).lean();

      const asCleanString = (value) =>
        typeof value === "string" && value.trim().length > 0 ? value.trim() : "";

      const parseLanguages = (value) => {
        if (Array.isArray(value)) {
          return value
            .map((entry) => asCleanString(entry))
            .filter(Boolean);
        }

        if (typeof value === "string") {
          return value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
        }

        return [];
      };

      const parsedBodyLanguages = parseLanguages(languages);
      const parsedFirestoreLanguages = parseLanguages(userData.languages);
      const parsedExistingLanguages = parseLanguages(existingSoultee?.languages);

      const resolvedName =
        asCleanString(name) ||
        asCleanString(userData.name) ||
        asCleanString(userData.displayName) ||
        asCleanString(existingSoultee?.name);

      if (!resolvedName) {
        return res.status(400).json({ message: "SOULTEE name is missing in request and profile" });
      }

      const resolvedCategory =
        asCleanString(userData.soulteeType) || asCleanString(existingSoultee?.category) || null;
      const resolvedGender =
        asCleanString(gender) ||
        asCleanString(userData.gender) ||
        asCleanString(existingSoultee?.gender) ||
        null;
      const resolvedSpecialization =
        asCleanString(specialization) ||
        asCleanString(userData.specialization) ||
        asCleanString(existingSoultee?.specialization) ||
        null;

      const rawExperienceYears =
        experienceYears ?? userData.experienceYears ?? existingSoultee?.experienceYears;
      const parsedExperienceYears = Number(rawExperienceYears);
      const resolvedExperienceYears = Number.isFinite(parsedExperienceYears)
        ? Math.max(0, parsedExperienceYears)
        : 0;

      const resolvedLanguages = parsedBodyLanguages.length
        ? parsedBodyLanguages
        : parsedFirestoreLanguages.length
          ? parsedFirestoreLanguages
          : parsedExistingLanguages;

      const resolvedBio =
        asCleanString(bio) ||
        asCleanString(userData.bio) ||
        asCleanString(existingSoultee?.bio) ||
        null;

      const profileImage =
        asCleanString(userData.profileImage) ||
        asCleanString(userData.photoURL) ||
        asCleanString(existingSoultee?.profileImage) ||
        null;

      const feeRaw = userData.feePerSession ?? userData.fees ?? existingSoultee?.feePerSession;
      const parsedFee = Number(feeRaw);
      const resolvedFeePerSession = Number.isFinite(parsedFee) ? Math.max(0, parsedFee) : 0;

      const durationRaw = userData.durationMinutes ?? existingSoultee?.durationMinutes;
      const parsedDuration = Number(durationRaw);
      const resolvedDurationMinutes = Number.isFinite(parsedDuration)
        ? Math.max(1, parsedDuration)
        : 60;

      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid },
        {
          firebaseUid,
          name: resolvedName,
          category: resolvedCategory,
          gender: resolvedGender,
          specialization: resolvedSpecialization,
          experienceYears: resolvedExperienceYears,
          languages: resolvedLanguages,
          bio: resolvedBio,
          profileImage,
          feePerSession: resolvedFeePerSession,
          durationMinutes: resolvedDurationMinutes,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Sync profile to Firebase RTDB for real-time reads
      syncProfileToRTDB(firebaseUid, {
        uid: firebaseUid,
        name: resolvedName,
        gender: resolvedGender,
        specialization: resolvedSpecialization,
        experienceYears: resolvedExperienceYears,
        languages: resolvedLanguages,
        bio: resolvedBio,
        category: soultee.category || null,
        status: soultee.status,
        rating: soultee.rating,
        profileImage: profileImage || soultee.profileImage || null,
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

      if (!admin.apps.length) {
        return res.status(500).json({ message: "Firebase not initialised" });
      }

      const userSnap = await admin
        .firestore()
        .collection("users")
        .doc(req.params.soulteeUid)
        .get();
      const userData = userSnap.data() || {};
      const isApproved = (userData.soulteeStatus || "").toString().toLowerCase() === "active" &&
        userData.rolePending !== true;

      if (!isApproved && status !== "offline") {
        return res.status(403).json({ message: "SOULTEE approval is required before going online" });
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
      const now = new Date();
      const todayStart  = new Date(now); todayStart.setHours(0,0,0,0);
      const todayEnd    = new Date(now); todayEnd.setHours(23,59,59,999);
      const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);

      const [soultee, activeStudents, pendingRequests, todaySessions, upcomingSessions, wallet] =
        await Promise.all([
          Soultee.findOne({ firebaseUid: soulteeUid })
            .select("rating totalFeedbacks feePerSession")
            .lean(),
          StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "active" }),
          StudentSoulteeLink.countDocuments({ soulteeFirebaseUid: soulteeUid, status: "pending" }),
          Session.countDocuments({
            soulteeFirebaseUid: soulteeUid,
            status: { $in: ["upcoming", "ongoing"] },
            scheduledAt: { $gte: todayStart, $lte: todayEnd },
          }),
          Session.countDocuments({
            soulteeFirebaseUid: soulteeUid,
            status: "upcoming",
            scheduledAt: { $gte: now },
          }),
          SessionWallet.findOne({ soulteeFirebaseUid: soulteeUid }).lean(),
        ]);

      const defaultFee = Number(soultee?.feePerSession || 0);

      // ── Full earnings aggregate ───────────────────────────────────────────
      const [agg] = await Session.aggregate([
        { $match: { soulteeFirebaseUid: soulteeUid } },
        {
          $project: {
            status: 1,
            sessionType: 1,
            scheduledAt: 1,
            adminPaid: 1,
            effectiveFee: { $ifNull: ["$sessionFee", defaultFee] },
            soulteeEarnings: {
              $ifNull: [
                "$soulteeEarnings",
                { $multiply: [{ $ifNull: ["$sessionFee", defaultFee] }, { $subtract: [1, { $divide: [PLATFORM_COMMISSION_RATE, 100] }] }] },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            completedSessions:   { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            pendingSessions:     { $sum: { $cond: [{ $in: ["$status", ["upcoming", "ongoing"]] }, 1, 0] } },
            chatSessions:        { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","chat"] }] }, 1, 0] } },
            voiceSessions:       { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","voice"] }] }, 1, 0] } },
            videoSessions:       { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","video"] }] }, 1, 0] } },
            // earningsToBeReceived = active/upcoming (full fee) + completed but admin hasn't paid yet (soultee's share)
            earningsToBeReceived: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["upcoming", "ongoing"]] },
                  "$effectiveFee",
                  {
                    $cond: [
                      { $and: [{ $eq: ["$status", "completed"] }, { $ne: ["$adminPaid", true] }] },
                      "$soulteeEarnings",
                      0,
                    ],
                  },
                ],
              },
            },
            thisMonthEarnings:   { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $gte: ["$scheduledAt", monthStart] }] }, "$soulteeEarnings", 0] } },
            todayEarnings:       { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $gte: ["$scheduledAt", todayStart] }, { $lte: ["$scheduledAt", todayEnd] }] }, "$soulteeEarnings", 0] } },
            chatEarnings:        { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","chat"] }] }, "$soulteeEarnings", 0] } },
            voiceEarnings:       { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","voice"] }] }, "$soulteeEarnings", 0] } },
            videoEarnings:       { $sum: { $cond: [{ $and: [{ $eq: ["$status","completed"] }, { $eq: ["$sessionType","video"] }] }, "$soulteeEarnings", 0] } },
            totalClientsServed:  { $addToSet: { $cond: [{ $eq: ["$status","completed"] }, "$studentFirebaseUid", null] } },
            totalDurationMins:   { $sum: { $cond: [{ $eq: ["$status","completed"] }, { $ifNull: ["$durationMinutes", 0] }, 0] } },
          },
        },
      ]);

      // ── Unique clients / repeat ───────────────────────────────────────────
      const clientSet    = (agg?.totalClientsServed ?? []).filter(Boolean);
      const uniqueClients = clientSet.length;
      const completedCount = agg?.completedSessions ?? 0;
      const repeatClients = Math.max(0, completedCount - uniqueClients);
      const avgSessionMins = completedCount > 0 ? Math.round((agg?.totalDurationMins ?? 0) / completedCount) : 0;

      // ── Wallet — only admin-confirmed payments count here ─────────────────
      const earnedSoFar     = wallet?.totalEarned ?? 0;   // incremented only when admin pays
      const totalWithdrawn  = wallet?.totalWithdrawn ?? 0;
      const pendingWd       = wallet?.pendingWithdrawals ?? 0;
      const availableBalance = Math.max(0, earnedSoFar - totalWithdrawn - pendingWd);

      const { totalUnreadMessages } = await getUnreadMessageSummary({ userId: soulteeUid, userRole: "soultee" });

      res.json({
        completedSessions:    completedCount,
        pendingSessions:      agg?.pendingSessions ?? 0,
        chatSessions:         agg?.chatSessions  ?? 0,
        voiceSessions:        agg?.voiceSessions ?? 0,
        videoSessions:        agg?.videoSessions ?? 0,
        activeStudents,
        pendingRequests,
        todaySessions,
        upcomingSessions,

        // Earnings
        earningsReceived:     earnedSoFar,
        earningsToBeReceived: agg?.earningsToBeReceived ?? 0,
        thisMonthEarnings:    agg?.thisMonthEarnings ?? 0,
        todayEarnings:        agg?.todayEarnings ?? 0,
        chatEarnings:         agg?.chatEarnings  ?? 0,
        voiceEarnings:        agg?.voiceEarnings ?? 0,
        videoEarnings:        agg?.videoEarnings ?? 0,

        // Wallet
        walletBalance:        availableBalance,
        availableBalance,
        withdrawableBalance:  availableBalance,
        pendingWithdrawals:   pendingWd,

        // Performance
        totalClientsServed:   uniqueClients,
        repeatClients,
        avgSessionMinutes:    avgSessionMins,

        unreadMessages:         totalUnreadMessages,
        rating:                 soultee?.rating ?? 0,
        totalFeedbacks:         soultee?.totalFeedbacks ?? 0,
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
      const now = new Date();
      const link = await StudentSoulteeLink.findOneAndUpdate(
        {
          soulteeFirebaseUid: req.params.soulteeUid,
          studentFirebaseUid: req.params.studentUid,
          status: "active",
        },
        { status: "ended", endedAt: now },
        { new: true }
      );

      if (!link) return res.status(404).json({ message: "Active link not found" });

      const sessionStart = link.acceptedAt || link.requestedAt || now;
      const durationMinutes = Math.max(1, Math.round((now - new Date(sessionStart)) / 60000));

      // Complete existing payment session if one exists, otherwise create a new record
      const completedExisting = await Session.findOneAndUpdate(
        {
          soulteeFirebaseUid: req.params.soulteeUid,
          studentFirebaseUid: req.params.studentUid,
          status: { $in: ["upcoming", "ongoing"] },
          sessionFee: { $gt: 0 },
        },
        { $set: { status: "completed", sessionType: "chat", durationMinutes, scheduledAt: sessionStart } },
        { new: true, sort: { createdAt: -1 } }
      );

      if (!completedExisting) {
        Session.create({
          soulteeFirebaseUid: req.params.soulteeUid,
          studentFirebaseUid: req.params.studentUid,
          studentName: link.studentName || "Student",
          scheduledAt: sessionStart,
          durationMinutes,
          sessionType: "chat",
          status: "completed",
        }).catch(() => {});
      }

      // Refresh soultee dashboard stats
      io.to(`soultee:${req.params.soulteeUid}`).emit("stats:updated");

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
      const { soulteeUid } = req.params;
      const filter = { soulteeFirebaseUid: soulteeUid };
      if (req.query.status)     filter.status             = req.query.status;
      if (req.query.studentUid) filter.studentFirebaseUid = req.query.studentUid;

      const sessions = await Session.find(filter)
        .sort({ scheduledAt: -1 })
        .limit(200)
        .lean();

      // Attach linkId (StudentSoulteeLink._id) so Flutter can open the chat room.
      const studentUids = [...new Set(sessions.map((s) => s.studentFirebaseUid))];
      const links = await StudentSoulteeLink.find({
        soulteeFirebaseUid: soulteeUid,
        studentFirebaseUid: { $in: studentUids },
      }).select("studentFirebaseUid _id").lean();

      const linkMap = {};
      for (const l of links) linkMap[l.studentFirebaseUid] = l._id.toString();

      const enriched = sessions.map((s) => ({
        ...s,
        linkId: linkMap[s.studentFirebaseUid] ?? null,
      }));

      res.json({ sessions: enriched, total: enriched.length });
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

  // ───────────────────────────────────────────────────────────────────────────
  //  STUDENT — submit feedback after a session
  //  POST /api/soultee-dashboard/:soulteeUid/feedback
  //  Body: { studentUid, studentName, rating (1-5), comment?, roomId? }
  // ───────────────────────────────────────────────────────────────────────────
  router.post("/:soulteeUid/feedback", async (req, res) => {
    try {
      const { soulteeUid } = req.params;
      const { studentUid, studentName, rating, comment, roomId } = req.body;

      if (!studentUid || !rating) {
        return res.status(400).json({ message: "studentUid and rating are required" });
      }
      const r = Number(rating);
      if (!Number.isFinite(r) || r < 1 || r > 5) {
        return res.status(400).json({ message: "rating must be between 1 and 5" });
      }

      // Prevent duplicate feedback for the same session
      if (roomId) {
        const existing = await SoulteeFeedback.findOne({ studentUid, soulteeUid, roomId });
        if (existing) {
          return res.status(409).json({ message: "Feedback already submitted for this session" });
        }
      }

      const feedback = await SoulteeFeedback.create({
        studentUid,
        soulteeUid,
        studentName: studentName || "Anonymous",
        rating: r,
        comment: (comment || "").trim(),
        roomId: roomId || null,
      });

      // Update soultee's average rating
      const [agg] = await SoulteeFeedback.aggregate([
        { $match: { soulteeUid } },
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]);
      if (agg) {
        await Soultee.findOneAndUpdate(
          { firebaseUid: soulteeUid },
          { rating: Math.round(agg.avg * 10) / 10, totalFeedbacks: agg.count }
        );
      }

      res.status(201).json({ success: true, feedback });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE — get all feedback received
  //  GET /api/soultee-dashboard/:soulteeUid/feedbacks?limit=20&page=1
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/feedbacks", async (req, res) => {
    try {
      const limit = Math.min(50, parseInt(req.query.limit) || 20);
      const page  = Math.max(1,  parseInt(req.query.page)  || 1);
      const skip  = (page - 1) * limit;

      const [feedbacks, total] = await Promise.all([
        SoulteeFeedback.find({ soulteeUid: req.params.soulteeUid })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        SoulteeFeedback.countDocuments({ soulteeUid: req.params.soulteeUid }),
      ]);

      res.json({ feedbacks, total, page, limit });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE — save / update bank account details
  //  PATCH /api/soultee-dashboard/:soulteeUid/bank-account
  //  Body: { bankName, accountNumber, accountHolder, branchName }
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/bank-account", async (req, res) => {
    try {
      const { bankName, accountNumber, accountHolder, branchName, bankQrUrl } = req.body;
      if (!accountNumber || !accountHolder) {
        return res.status(400).json({
          message: "accountNumber and accountHolder are required",
        });
      }
      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid: req.params.soulteeUid },
        {
          $set: {
            "bankAccount.bankName":      (bankName || "").trim(),
            "bankAccount.accountNumber": accountNumber.trim(),
            "bankAccount.accountHolder": accountHolder.trim(),
            "bankAccount.branchName":    (branchName || "").trim(),
            "bankAccount.bankQrUrl":     (bankQrUrl  || "").trim(),
            "bankAccount.updatedAt":     new Date(),
          },
        },
        { new: true }
      ).select("bankAccount").lean();

      if (!soultee) return res.status(404).json({ message: "Soultee not found" });
      res.json({ success: true, bankAccount: soultee.bankAccount });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE — update digital wallet (eSewa / Khalti number + QR URL)
  //  PATCH /api/soultee-dashboard/:soulteeUid/digital-wallet
  //  Body: { esewaNumber?, esewaQrUrl?, khaltiNumber?, khaltiQrUrl? }
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/digital-wallet", async (req, res) => {
    try {
      const { esewaNumber, esewaQrUrl, khaltiNumber, khaltiQrUrl } = req.body;
      const update = {};
      if (esewaNumber  !== undefined) update.esewaNumber  = (esewaNumber  || "").trim();
      if (esewaQrUrl   !== undefined) update.esewaQrUrl   = (esewaQrUrl   || "").trim();
      if (khaltiNumber !== undefined) update.khaltiNumber = (khaltiNumber || "").trim();
      if (khaltiQrUrl  !== undefined) update.khaltiQrUrl  = (khaltiQrUrl  || "").trim();

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ message: "No fields provided" });
      }

      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid: req.params.soulteeUid },
        { $set: update },
        { new: true }
      ).select("esewaNumber esewaQrUrl khaltiNumber khaltiQrUrl").lean();

      if (!soultee) return res.status(404).json({ message: "Soultee not found" });
      res.json({ success: true, ...soultee });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE / STUDENT — get soultee payment info (bank + QR URLs)
  //  GET /api/soultee-dashboard/:soulteeUid/payment-info
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/payment-info", async (req, res) => {
    try {
      const soultee = await Soultee.findOne({ firebaseUid: req.params.soulteeUid })
        .select("name feePerSession currency bankAccount esewaNumber esewaQrUrl khaltiNumber khaltiQrUrl")
        .lean();
      if (!soultee) return res.status(404).json({ message: "Soultee not found" });
      res.json(soultee);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  SOULTEE — set / update own consultation fee
  //  PATCH /api/soultee-dashboard/:soulteeUid/fee
  //  Body: { feePerSession: Number, currency?: String }
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/fee", async (req, res) => {
    try {
      const { soulteeUid } = req.params;
      const { feePerSession, currency } = req.body;

      if (feePerSession === undefined || feePerSession === null) {
        return res.status(400).json({ message: "feePerSession is required" });
      }
      const fee = Number(feePerSession);
      if (!Number.isFinite(fee) || fee < 0) {
        return res.status(400).json({ message: "feePerSession must be a non-negative number" });
      }

      const update = { feePerSession: fee };
      if (currency) update.currency = currency.toString().toUpperCase();

      const soultee = await Soultee.findOneAndUpdate(
        { firebaseUid: soulteeUid },
        { $set: update },
        { new: true }
      ).select("name feePerSession currency").lean();

      if (!soultee) return res.status(404).json({ message: "Soultee not found" });

      res.json({ success: true, soultee });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  STUDENT — get a single soultee's fee before booking
  //  GET /api/soultee-dashboard/:soulteeUid/fee
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/fee", async (req, res) => {
    try {
      const soultee = await Soultee.findOne({ firebaseUid: req.params.soulteeUid })
        .select("name feePerSession currency")
        .lean();
      if (!soultee) return res.status(404).json({ message: "Soultee not found" });
      res.json({
        soulteeId: req.params.soulteeUid,
        name: soultee.name,
        feePerSession: soultee.feePerSession ?? 0,
        currency: soultee.currency ?? "NPR",
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  NOTIFY STUDENTS — I'M AVAILABLE NOW
  //  POST /api/soultee-dashboard/:soulteeUid/notify-available
  //  Sends a real FCM push to every student linked to this soultee.
  // ───────────────────────────────────────────────────────────────────────────
  router.post("/:soulteeUid/notify-available", async (req, res) => {
    try {
      const { soulteeUid } = req.params;

      const soultee = await Soultee.findOne({ firebaseUid: soulteeUid })
        .select("name profileImage")
        .lean();
      const soulteeName  = soultee?.name || "Your Soultee";
      const profileImage = soultee?.profileImage || "";

      // All students who have an active or pending link with this soultee
      const links = await StudentSoulteeLink.find({
        soulteeFirebaseUid: soulteeUid,
        status: { $in: ["active", "pending"] },
      }).select("studentFirebaseUid studentName").lean();

      if (!links.length) {
        return res.json({ message: "No connected students to notify.", notified: 0 });
      }

      const title = `${soulteeName} is Available Now 🟢`;
      const body  = "Your Soultee is online and ready for counselling. Tap to connect!";

      let notified = 0;
      await Promise.all(
        links.map(async (link) => {
          try {
            // createNotification: saves to MongoDB + syncs RTDB + sends FCM push
            // → notification appears in student's bell AND as phone push
            await createNotification(io, {
              recipientUid:  link.studentFirebaseUid,
              recipientRole: "student",
              type:          "soultee_available",
              title,
              body,
              data: {
                type:        "soultee_available",
                soulteeId:   soulteeUid,
                soulteeName,
                profileImage,
                screen:      "soultee_search",
              },
            });
            notified++;
          } catch (_) {}
        })
      );

      res.json({ message: `${notified} student(s) notified.`, notified, total: links.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  ACTIVE SESSION
  //  GET /api/soultee-dashboard/:soulteeUid/active-session
  //  Returns the current ongoing session (or null).
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/active-session", async (req, res) => {
    try {
      const session = await Session.findOne({
        soulteeFirebaseUid: req.params.soulteeUid,
        status: "ongoing",
      }).lean();

      if (!session) return res.json({ session: null });

      const startedAt      = session.startedAt || session.scheduledAt;
      const durationMs     = (session.durationMinutes || 10) * 60 * 1000;
      const elapsed        = Date.now() - new Date(startedAt).getTime();
      const remainingMs    = Math.max(0, durationMs - elapsed);
      const remainingSecs  = Math.floor(remainingMs / 1000);

      const fee = session.sessionFee || 0;
      const soulteeEarnings = session.soulteeEarnings ??
        fee * (1 - PLATFORM_COMMISSION_RATE / 100);

      res.json({
        session: {
          ...session,
          remainingSeconds: remainingSecs,
          soulteeEarnings,
        },
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  START SESSION TIMER
  //  PATCH /api/soultee-dashboard/:soulteeUid/sessions/:sessionId/start
  //  Transitions session to "ongoing" and records startedAt.
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/sessions/:sessionId/start", async (req, res) => {
    try {
      const session = await Session.findOneAndUpdate(
        { _id: req.params.sessionId, soulteeFirebaseUid: req.params.soulteeUid, status: "upcoming" },
        { $set: { status: "ongoing", startedAt: new Date() } },
        { new: true }
      );
      if (!session) return res.status(404).json({ message: "Session not found or already started" });

      io.to(`session:${req.params.sessionId}`).emit("session:started", {
        sessionId: req.params.sessionId,
        startedAt: session.startedAt,
        durationMinutes: session.durationMinutes,
      });
      io.to(`soultee:${req.params.soulteeUid}`).emit("stats:updated");

      // Auto-complete after session duration expires
      const durationMs = (session.durationMinutes || 10) * 60 * 1000;
      setTimeout(async () => {
        try {
          const s = await Session.findOne({ _id: req.params.sessionId });
          if (!s || s.status !== "ongoing") return;
          const fee = s.sessionFee || 0;
          const rate = s.commissionRate ?? PLATFORM_COMMISSION_RATE;
          const soulteeEarnings = +(fee * (1 - rate / 100)).toFixed(2);
          const platformEarnings = +(fee * rate / 100).toFixed(2);
          s.status = "completed";
          s.soulteeEarnings = soulteeEarnings;
          s.platformEarnings = platformEarnings;
          // adminPaid stays false — wallet only updates when admin explicitly pays the soultee
          await s.save();
          io.to(`session:${req.params.sessionId}`).emit("session:completed", { sessionId: req.params.sessionId });
          io.to(`soultee:${req.params.soulteeUid}`).emit("stats:updated");
        } catch (autoErr) {
          console.error("Auto-complete session error:", autoErr.message);
        }
      }, durationMs);

      res.json({ session });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  COMPLETE SESSION & UPDATE WALLET
  //  PATCH /api/soultee-dashboard/:soulteeUid/sessions/:sessionId/complete
  // ───────────────────────────────────────────────────────────────────────────
  router.patch("/:soulteeUid/sessions/:sessionId/complete", async (req, res) => {
    try {
      const session = await Session.findOne({
        _id: req.params.sessionId,
        soulteeFirebaseUid: req.params.soulteeUid,
      });
      if (!session) return res.status(404).json({ message: "Session not found" });
      if (session.status === "completed") return res.json({ session });

      const fee      = session.sessionFee || 0;
      const rate     = session.commissionRate ?? PLATFORM_COMMISSION_RATE;
      const soulteeEarnings  = +(fee * (1 - rate / 100)).toFixed(2);
      const platformEarnings = +(fee * rate / 100).toFixed(2);

      session.status          = "completed";
      session.soulteeEarnings = soulteeEarnings;
      session.platformEarnings= platformEarnings;
      // adminPaid stays false — wallet only updates when admin explicitly pays the soultee
      await session.save();

      io.to(`session:${req.params.sessionId}`).emit("session:completed", {
        sessionId: req.params.sessionId,
      });

      // Push real-time dashboard refresh to the soultee
      io.to(`soultee:${req.params.soulteeUid}`).emit("stats:updated");

      res.json({ session, soulteeEarnings, platformEarnings });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  WALLET INFO
  //  GET /api/soultee-dashboard/:soulteeUid/wallet
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/wallet", async (req, res) => {
    try {
      const wallet = await SessionWallet.findOne({ soulteeFirebaseUid: req.params.soulteeUid }).lean();
      const earned     = wallet?.totalEarned    ?? 0;
      const withdrawn  = wallet?.totalWithdrawn ?? 0;
      const pending    = wallet?.pendingWithdrawals ?? 0;
      const available  = Math.max(0, earned - withdrawn - pending);

      res.json({
        totalEarned: earned,
        totalWithdrawn: withdrawn,
        pendingWithdrawals: pending,
        availableBalance: available,
        withdrawableBalance: available,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  REQUEST WITHDRAWAL
  //  POST /api/soultee-dashboard/:soulteeUid/withdrawals
  //  Body: { amount, method, accountDetails }
  // ───────────────────────────────────────────────────────────────────────────
  router.post("/:soulteeUid/withdrawals", async (req, res) => {
    try {
      const { soulteeUid } = req.params;
      const { amount, method, accountDetails } = req.body;

      if (!amount || amount < 100) {
        return res.status(400).json({ message: "Minimum withdrawal amount is NPR 100." });
      }
      if (!["esewa", "khalti", "bank"].includes(method)) {
        return res.status(400).json({ message: "Invalid method. Use esewa, khalti, or bank." });
      }

      // Check available balance
      const wallet = await SessionWallet.findOne({ soulteeFirebaseUid: soulteeUid }).lean();
      const earned    = wallet?.totalEarned ?? 0;
      const withdrawn = wallet?.totalWithdrawn ?? 0;
      const pending   = wallet?.pendingWithdrawals ?? 0;
      const available = Math.max(0, earned - withdrawn - pending);

      if (amount > available) {
        return res.status(400).json({ message: `Insufficient balance. Available: NPR ${available}.` });
      }

      const wd = await SessionWithdrawal.create({
        soulteeFirebaseUid: soulteeUid,
        amount,
        method,
        accountDetails: accountDetails || {},
      });

      // Reserve the amount
      await SessionWallet.findOneAndUpdate(
        { soulteeFirebaseUid: soulteeUid },
        { $inc: { pendingWithdrawals: amount } },
        { upsert: true }
      );

      res.json({ withdrawal: wd, message: "Withdrawal request submitted." });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  WITHDRAWAL HISTORY
  //  GET /api/soultee-dashboard/:soulteeUid/withdrawals?status=&page=
  // ───────────────────────────────────────────────────────────────────────────
  router.get("/:soulteeUid/withdrawals", async (req, res) => {
    try {
      const { status, page = "1", limit = "20" } = req.query;
      const filter = { soulteeFirebaseUid: req.params.soulteeUid };
      if (status) filter.status = status;

      const [withdrawals, total] = await Promise.all([
        SessionWithdrawal.find(filter)
          .sort({ createdAt: -1 })
          .skip((parseInt(page) - 1) * parseInt(limit))
          .limit(parseInt(limit))
          .lean(),
        SessionWithdrawal.countDocuments(filter),
      ]);

      res.json({ withdrawals, total });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
