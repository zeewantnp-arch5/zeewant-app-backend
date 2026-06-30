import mongoose from "mongoose";

const systemSettingsSchema = new mongoose.Schema(
  {
    key:      { type: String, required: true, unique: true, index: true },
    value:    { type: mongoose.Schema.Types.Mixed, required: true },
    category: {
      type: String,
      enum: ["general", "security", "notifications", "badges", "onboarding", "integrations"],
      required: true,
    },
    label:       { type: String },
    description: { type: String },
    updatedBy:   { type: String },
    updatedByName: { type: String },
  },
  { timestamps: true }
);

// Seed defaults if collection is empty
systemSettingsSchema.statics.ensureDefaults = async function () {
  const count = await this.countDocuments();
  if (count > 0) return;

  const defaults = [
    // General
    { key: "app_maintenance_mode",       value: false,  category: "general",       label: "App Maintenance Mode",         description: "Put the app in read-only maintenance mode" },
    { key: "user_registration_enabled",  value: true,   category: "general",       label: "User Registration",            description: "Allow new users to register" },
    { key: "soultee_onboarding_enabled", value: true,   category: "general",       label: "SOULTEE Onboarding",           description: "Accept new SOULTEE applications" },
    { key: "platform_name",              value: "Zeewant", category: "general",    label: "Platform Name",                description: "Name of the platform" },
    { key: "support_email",              value: "support@zeewant.com", category: "general", label: "Support Email", description: "Public support email" },
    // Security
    { key: "two_factor_auth",            value: true,   category: "security",      label: "Two-Factor Authentication",    description: "Require 2FA for admin logins" },
    { key: "session_timeout_minutes",    value: 30,     category: "security",      label: "Session Timeout (min)",        description: "Auto-logout after inactivity" },
    { key: "e2e_encryption",             value: true,   category: "security",      label: "End-to-End Encryption",        description: "Encrypt all session chat messages" },
    { key: "audit_logging",              value: true,   category: "security",      label: "Audit Logging",                description: "Log all admin and system actions" },
    // Notifications
    { key: "fcm_push_enabled",           value: true,   category: "notifications", label: "FCM Push Notifications",       description: "Send push notifications via FCM" },
    { key: "email_notifications",        value: true,   category: "notifications", label: "Email Notifications",          description: "Send email notifications to users" },
    // Badges
    { key: "badge_diamond_min_score",    value: 90,     category: "badges",        label: "Diamond Badge Min Score",      description: "Minimum performance score for Diamond badge" },
    { key: "badge_gold_min_score",       value: 75,     category: "badges",        label: "Gold Badge Min Score",         description: "Minimum performance score for Gold badge" },
    { key: "badge_auto_assign",          value: true,   category: "badges",        label: "Auto-Assign Badges",           description: "Automatically compute and assign badges" },
    // Onboarding
    { key: "min_completeness_score",     value: 60,     category: "onboarding",    label: "Min Completeness Score",       description: "Minimum profile completeness to be reviewable" },
    { key: "require_cert_for_coach",     value: true,   category: "onboarding",    label: "Require Cert for Coaches",     description: "Coaches must upload at least one certification" },
    // Integrations
    { key: "firebase_auth_enabled",      value: true,   category: "integrations",  label: "Firebase Auth",                description: "Firebase phone authentication" },
    // Revenue
    { key: "platform_commission_rate",   value: 10,     category: "general",       label: "Platform Commission %",        description: "Commission % deducted from each session fee. Remaining goes to soultee." },
  ];

  await this.insertMany(defaults);
};

export default mongoose.model("SystemSettings", systemSettingsSchema);
