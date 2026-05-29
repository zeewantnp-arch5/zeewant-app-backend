import mongoose from "mongoose";

const certificationSchema = new mongoose.Schema(
  {
    name:        { type: String },
    institution: { type: String },
    year:        { type: Number },
    documentUrl: { type: String },
  },
  { _id: false }
);

const auditEntrySchema = new mongoose.Schema(
  {
    // 'submitted' | 'resubmitted' | 'under_review' | 'approved' | 'rejected' | 'revision_requested'
    action:    { type: String, required: true },
    adminId:   { type: String },
    adminName: { type: String },
    comment:   { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const soulteeApplicationSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    firebaseUid: { type: String, required: true, unique: true, index: true },

    // ── Personal details ──────────────────────────────────────────────────────
    name:        { type: String, required: true },
    phone:       { type: String },
    email:       { type: String },
    dateOfBirth: { type: Date },
    gender:      { type: String, enum: ["Male", "Female", "Non-binary", "Prefer not to say", ""] },
    city:        { type: String },
    country:     { type: String },

    // ── Professional category ─────────────────────────────────────────────────
    category: {
      type: String,
      enum: ["Peer Counsellor", "Coach", "Life Warrior"],
    },

    // ── Professional profile ──────────────────────────────────────────────────
    specializations:      [String],
    experienceYears:      { type: Number },
    bio:                  { type: String },
    languages:            [String],
    feePerSession:        { type: Number },
    durationMinutes:      { type: Number },
    availabilityHours:    { type: String },

    // ── Emotional support capabilities ────────────────────────────────────────
    emotionalSupportAreas: [String],

    // ── Qualifications & documents ────────────────────────────────────────────
    certifications: [certificationSchema],

    // ── Media ─────────────────────────────────────────────────────────────────
    profileImageUrl: { type: String },
    introVideoUrl:   { type: String },
    socialLinks: {
      linkedin: { type: String },
      website:  { type: String },
    },

    // ── Application lifecycle ─────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "under_review", "approved", "rejected", "revision_requested"],
      default: "pending",
      index:   true,
    },

    // Calculated on each submit / resubmit (0–100)
    completenessScore: { type: Number, default: 0 },

    // System-generated flags for admin attention
    riskFlags: [String],

    // ── Admin decision fields ─────────────────────────────────────────────────
    adminComment: { type: String },
    badgeLevel:   { type: String, enum: ["Gold", "Silver", "Diamond", ""], default: "" },
    reviewedBy:   { type: String },     // admin JWT id
    reviewedAt:   { type: Date },

    // ── Timestamps ────────────────────────────────────────────────────────────
    submittedAt:   { type: Date, default: Date.now },
    resubmittedAt: { type: Date },

    // ── Immutable audit trail ─────────────────────────────────────────────────
    auditLog: [auditEntrySchema],
  },
  { timestamps: true }
);

soulteeApplicationSchema.index({ status: 1, submittedAt: -1 });
soulteeApplicationSchema.index({ category: 1, status: 1 });

// ── Helpers (exported for reuse in routes) ────────────────────────────────────

export function computeCompletenessScore(data) {
  let score = 0;
  if (data.name)                              score += 10;
  if (data.bio && data.bio.length > 30)       score += 10;
  if (data.category)                          score += 10;
  if (data.specializations?.length)           score += 10;
  if (data.experienceYears != null)           score += 10;
  if (data.emotionalSupportAreas?.length)     score += 10;
  if (data.certifications?.length)            score += 10;
  if (data.languages?.length)                 score += 10;
  if (data.profileImageUrl)                   score += 10;
  if (data.phone || data.email)               score += 10;
  return score;
}

export function computeRiskFlags(data) {
  const flags = [];
  const score = computeCompletenessScore(data);
  if (score < 60)                             flags.push("Profile completeness below 60%");
  if (!data.certifications?.length)           flags.push("No certifications provided");
  if (!data.profileImageUrl)                  flags.push("No profile photo uploaded");
  if ((data.experienceYears ?? 0) < 1 && data.category === "Coach") {
    flags.push("Coach applicant with less than 1 year of experience");
  }
  return flags;
}

export default mongoose.model("SoulteeApplication", soulteeApplicationSchema);
