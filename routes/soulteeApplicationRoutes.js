import express from "express";
import multer from "multer";
import SoulteeApplication, {
  computeCompletenessScore,
  computeRiskFlags,
} from "../models/SoulteeApplication.js";
import admin from "../config/firebase.js";

// Accepts images and PDFs for certifications / profile photo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "application/pdf",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only images (JPEG/PNG/WebP) and PDF files are allowed"));
  },
});

// Factory: receives `io` so approval events can be emitted to admins
export default function createSoulteeApplicationRoutes(io) {
  const router = express.Router();

  const normalizeSoulteeCategory = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw == 'peer counsellor' ||
        raw == 'peer counselor' ||
        raw == 'peer counselling' ||
        raw == 'peer counseling' ||
        raw == 'peer' ||
        raw == 'peers') {
      return 'Peer Counsellor';
    }
    if (raw == 'coach' || raw == 'coaching') {
      return 'Coach';
    }
    if (raw == 'life warrior' || raw == 'warrior' || raw == 'lifewarrior') {
      return 'Life Warrior';
    }
    return String(value || '').trim();
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  POST /api/soultee-application/submit
  //  Body (JSON): all onboarding fields
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/submit", async (req, res) => {
    try {
      const {
        firebaseUid, name, phone, email, dateOfBirth, gender, city, country,
        category, specializations, experienceYears, bio, languages,
        feePerSession, durationMinutes, availabilityHours, emotionalSupportAreas,
        certifications, profileImageUrl, introVideoUrl, socialLinks,
      } = req.body;

      if (!firebaseUid || !name) {
        return res.status(400).json({ message: "firebaseUid and name are required" });
      }

      // Check for a live application (pending / under_review / approved)
      const existing = await SoulteeApplication.findOne({ firebaseUid });
      if (existing && ["pending", "under_review", "approved"].includes(existing.status)) {
        return res.status(409).json({
          message: `An application already exists with status: ${existing.status}`,
          status: existing.status,
          applicationId: existing._id,
        });
      }

      const payload = {
        firebaseUid, name, phone, email, dateOfBirth, gender, city, country,
        category: normalizeSoulteeCategory(category),
        specializations, experienceYears, bio, languages,
        feePerSession, durationMinutes, availabilityHours, emotionalSupportAreas,
        certifications, profileImageUrl, introVideoUrl, socialLinks,
      };

      const completenessScore = computeCompletenessScore(payload);
      const riskFlags         = computeRiskFlags(payload);

      let application;

      if (existing) {
        // Resubmission after rejection or revision request
        Object.assign(existing, payload);
        existing.status           = "pending";
        existing.completenessScore = completenessScore;
        existing.riskFlags        = riskFlags;
        existing.resubmittedAt    = new Date();
        existing.adminComment     = "";
        existing.auditLog.push({
          action:    "resubmitted",
          comment:   "Application resubmitted by applicant",
          timestamp: new Date(),
        });
        application = await existing.save();
      } else {
        application = await SoulteeApplication.create({
          ...payload,
          completenessScore,
          riskFlags,
          submittedAt: new Date(),
          auditLog: [{
            action:    "submitted",
            comment:   "Application submitted",
            timestamp: new Date(),
          }],
        });
      }

      // Notify admin dashboard in real-time
      io.to("admin:notifications").emit("new_soultee_application", {
        applicationId:    application._id,
        applicantName:    name,
        category:         category || "",
        completenessScore,
        riskCount:        riskFlags.length,
        submittedAt:      application.submittedAt,
      });

      res.status(201).json({
        message:          "Application submitted successfully",
        applicationId:    application._id,
        completenessScore,
        riskFlags,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  POST /api/soultee-application/upload-document
  //  Multipart: field "document", optional field "firebaseUid"
  //  Returns: { url }
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/upload-document", upload.single("document"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }

    try {
      if (!admin.apps.length) {
        return res.status(500).json({ message: "Firebase not initialised" });
      }

      const bucket = admin.storage().bucket();
      const uid    = req.body.firebaseUid || "unknown";
      const ext    = req.file.originalname.split(".").pop().toLowerCase();
      const path   = `soultee-applications/${uid}/${Date.now()}.${ext}`;
      const ref    = bucket.file(path);

      await ref.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
      });

      const [url] = await ref.getSignedUrl({
        action:  "read",
        expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
      });

      res.json({ url, message: "Document uploaded successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  GET /api/soultee-application/status/:uid
  //  Returns the applicant's own application (no audit log)
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/status/:uid", async (req, res) => {
    try {
      const application = await SoulteeApplication
        .findOne({ firebaseUid: req.params.uid })
        .select("-auditLog")
        .lean();

      if (!application) {
        return res.status(404).json({ message: "No application found" });
      }

      res.json({ application });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
