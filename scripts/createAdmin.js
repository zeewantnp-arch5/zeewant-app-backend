/**
 * Seeds all 5 role-based admin accounts into MongoDB.
 * Run once:  node scripts/createAdmin.js
 *
 * Edit the accounts below before running.
 * Re-running is safe — existing accounts are skipped.
 */

import "dotenv/config";
import mongoose from "mongoose";
import AdminUser from "../models/AdminUser.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI not set in .env");
  process.exit(1);
}

// ─── Define one account per role ─────────────────────────────────────────────
// Change usernames / emails / passwords to whatever you want.
// The role field determines which dashboard the user sees after login.
const ADMINS = [
  {
    username: "superadmin",
    email: "superadmin@zeewant.com",
    password: "Super@2026",
    name: "Super Admin",
    role: "superAdmin",
  },
  {
    username: "analytics",
    email: "analytics@zeewant.com",
    password: "Analytics@2026",
    name: "Analytics Admin",
    role: "analyticsAdmin",
  },
  {
    username: "security",
    email: "security@zeewant.com",
    password: "Security@2026",
    name: "Security Admin",
    role: "securityAdmin",
  },
  {
    username: "marketing",
    email: "marketing@zeewant.com",
    password: "Marketing@2026",
    name: "Marketing Admin",
    role: "marketingAdmin",
  },
  {
    username: "support",
    email: "support@zeewant.com",
    password: "Support@2026",
    name: "Support Admin",
    role: "supportAdmin",
  },
];
// ─────────────────────────────────────────────────────────────────────────────

await mongoose.connect(MONGO_URI);
console.log("✅  Connected to MongoDB\n");

for (const data of ADMINS) {
  const existing = await AdminUser.findOne({
    $or: [{ username: data.username }, { email: data.email }],
  });

  if (existing) {
    console.log(`⚠️   Already exists — skipping: ${data.username} (${data.role})`);
    continue;
  }

  const admin = new AdminUser({
    username: data.username,
    email: data.email,
    name: data.name,
    role: data.role,
  });
  await admin.setPassword(data.password);
  await admin.save();
  console.log(`✅  Created: ${data.username}  |  role: ${data.role}  |  password: ${data.password}`);
}

console.log("\nDone. All admin accounts are ready.");
await mongoose.disconnect();
process.exit(0);
