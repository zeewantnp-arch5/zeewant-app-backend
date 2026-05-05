import express from "express";
import EmotionalPrescription from "../models/EmotionalPrescription.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Notification from "../models/Notification.js";
import { updateNotificationInRTDB } from "../config/firebase.js";
import { sendPushNotification } from "../services/fcmService.js";

const router = express.Router();

// ── POST /api/emotional-prescription/submit ───────────────────────────────────
// Student submits form → saved as pending, routed to their linked soultee
router.post("/submit", async (req, res) => {
  try {
    const {
      userId,
      studentName = "",
      age,
      educationLevel,
      problem,
      emotionalState,
      currentSituation,
      moodData = {},
      activityData = {},
      stabilityScore = 0,
    } = req.body;

    if (!userId || !problem || !emotionalState || !currentSituation) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Find linked soultee
    const link = await StudentSoulteeLink.findOne({
      studentFirebaseUid: userId,
      status: "active",
    }).select("soulteeFirebaseUid").lean();

    const soulteeUid = link?.soulteeFirebaseUid || "";

    const doc = await EmotionalPrescription.create({
      userId,
      studentName,
      soulteeUid,
      status: "pending",
      input: { age, educationLevel, emotionalState, problem, currentSituation, stabilityScore },
    });

    // Notify soultee in real-time
    if (soulteeUid) {
      try {
        const displayName = studentName || "A student";
        const notif = await Notification.create({
          recipientUid: soulteeUid,
          recipientRole: "soultee",
          type: "prescription_request",
          title: "New Prescription Request 📋",
          body: `${displayName} has submitted an emotional prescription request.`,
          data: { prescriptionId: String(doc._id), studentName: displayName },
        });
        updateNotificationInRTDB(soulteeUid, String(notif._id), {
          type: notif.type,
          title: notif.title,
          body: notif.body,
          read: false,
          createdAt: notif.createdAt.toISOString(),
          data: { prescriptionId: String(doc._id), studentName: displayName },
        });
        sendPushNotification(soulteeUid, {
          title: notif.title,
          body: notif.body,
          data: { prescriptionId: String(doc._id), type: "prescription_request" },
        });
      } catch (notifErr) {
        console.warn("[prescription] soultee notification error:", notifErr.message);
      }
    }

    return res.status(200).json({ id: doc._id, status: "pending", soulteeAssigned: !!soulteeUid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/emotional-prescription/pending/:soulteeUid ───────────────────────
// Soultee fetches pending requests from their students
router.get("/pending/:soulteeUid", async (req, res) => {
  try {
    const docs = await EmotionalPrescription.find({
      soulteeUid: req.params.soulteeUid,
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json(docs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/emotional-prescription/fulfill/:id ───────────────────────────────
// Soultee fills and submits the prescription
router.put("/fulfill/:id", async (req, res) => {
  const {
    emotionalDiagnosis,
    rootCause,
    dailyRx,
    weeklyRx,
    emergencyRx,
    whatToAvoid,
    mindsetShift,
    supportSuggestion,
    closingNote,
  } = req.body;

  if (!emotionalDiagnosis || !rootCause || !dailyRx) {
    return res.status(400).json({ error: "emotionalDiagnosis, rootCause and dailyRx are required." });
  }

  try {
    const doc = await EmotionalPrescription.findByIdAndUpdate(
      req.params.id,
      {
        status: "completed",
        emotionalDiagnosis,
        rootCause,
        dailyRx,
        weeklyRx: weeklyRx || "",
        emergencyRx: emergencyRx || "",
        whatToAvoid: whatToAvoid || "",
        mindsetShift: mindsetShift || "",
        supportSuggestion: supportSuggestion || "",
        closingNote: closingNote || "",
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: "Prescription not found." });

    // Notify student
    try {
      const notif = await Notification.create({
        recipientUid: doc.userId,
        recipientRole: "student",
        type: "prescription_ready",
        title: "Your Prescription is Ready 💊",
        body: "Your Soultee has filled your emotional prescription. Tap to view it.",
        data: { prescriptionId: String(doc._id) },
      });
      updateNotificationInRTDB(doc.userId, String(notif._id), {
        type: notif.type,
        title: notif.title,
        body: notif.body,
        read: false,
        createdAt: notif.createdAt.toISOString(),
          data: { prescriptionId: String(doc._id) },
        });
      sendPushNotification(doc.userId, {
        title: notif.title,
        body: notif.body,
        data: { prescriptionId: String(doc._id), type: "prescription_ready" },
      });
    } catch (notifErr) {
      console.warn("[prescription] notification error:", notifErr.message);
    }

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/emotional-prescription/history/:userId ───────────────────────────
// Student views their prescriptions (only completed ones shown with full data)
router.get("/history/:userId", async (req, res) => {
  try {
    const docs = await EmotionalPrescription.find(
      { userId: req.params.userId, status: "completed" },
      { rawText: 0 }
    )
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.status(200).json(docs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
