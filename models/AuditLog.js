import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    // Who performed the action
    adminId:   { type: String, required: true, index: true },
    adminName: { type: String, required: true },
    adminRole: { type: String, required: true },

    // What was done
    action: {
      type: String,
      enum: [
        "login", "logout",
        "user_blocked", "user_unblocked", "user_role_changed",
        "soultee_approved", "soultee_rejected", "soultee_revision_requested",
        "soultee_suspended", "soultee_reactivated",
        "soulpana_assigned", "soulpana_closed",
        "admin_created", "admin_deleted", "admin_role_changed",
        "settings_updated", "badge_assigned",
        "data_export", "report_generated",
        "security_alert_dismissed",
        "video_viewed", "document_viewed",
      ],
      required: true,
      index: true,
    },

    // Resource being acted on
    resourceType: {
      type: String,
      enum: ["user", "soultee", "soultee_application", "admin", "soulpana",
             "settings", "session", "notification", "media", "system"],
    },
    resourceId:   { type: String },
    resourceName: { type: String },

    // Human-readable description
    description: { type: String, required: true },

    // Extra structured context (flexible)
    metadata: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },

    // Severity: info | warn | critical
    severity: { type: String, enum: ["info", "warn", "critical"], default: "info" },

    // Client info
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ adminId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ severity: 1, createdAt: -1 });

export default mongoose.model("AuditLog", auditLogSchema);
