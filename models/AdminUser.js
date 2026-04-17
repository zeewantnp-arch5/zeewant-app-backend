import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const ROLES = [
  "superAdmin",
  "analyticsAdmin",
  "securityAdmin",
  "marketingAdmin",
  "supportAdmin",
];

const adminUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    isActive: { type: Boolean, default: true },
    resetToken: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
  },
  { timestamps: true }
);

/** Hash the plain password and store it. */
adminUserSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

/** Returns true if `plain` matches the stored hash. */
adminUserSchema.methods.verifyPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

export const ADMIN_ROLES = ROLES;
export default mongoose.model("AdminUser", adminUserSchema);
