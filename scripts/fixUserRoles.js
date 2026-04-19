import "dotenv/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import admin from "../config/firebase.js";

const ALLOWED_ROLES = new Set(["student", "soultee"]);

function parseArgs(argv) {
  const flags = {
    apply: false,
    uid: "",
    role: "",
    file: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      flags.apply = true;
      continue;
    }
    if (arg === "--uid") {
      flags.uid = (argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--role") {
      flags.role = (argv[i + 1] || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--file") {
      flags.file = (argv[i + 1] || "").trim();
      i += 1;
    }
  }

  return flags;
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/fixUserRoles.js --uid <firebaseUid> --role <student|soultee> [--apply]");
  console.log("  node scripts/fixUserRoles.js --file <path-to-json> [--apply]");
  console.log("");
  console.log("Default mode is DRY RUN (no writes).");
  console.log("Add --apply to update Firestore.");
  console.log("");
  console.log("JSON file format:");
  console.log("[");
  console.log("  { \"uid\": \"firebase-uid-1\", \"role\": \"soultee\" },");
  console.log("  { \"uid\": \"firebase-uid-2\", \"role\": \"student\" }");
  console.log("]");
}

function normalizeItems({ uid, role, file }) {
  if (file) {
    const absolutePath = resolve(process.cwd(), file);
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error("Input file must be a JSON array.");
    }

    return parsed.map((item, index) => {
      const parsedUid = String(item?.uid || "").trim();
      const parsedRole = String(item?.role || "").trim().toLowerCase();

      if (!parsedUid) {
        throw new Error(`Invalid uid at index ${index}.`);
      }
      if (!ALLOWED_ROLES.has(parsedRole)) {
        throw new Error(`Invalid role at index ${index}: ${parsedRole}`);
      }

      return { uid: parsedUid, role: parsedRole };
    });
  }

  if (!uid || !role) {
    throw new Error("Provide both --uid and --role, or provide --file.");
  }
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error(`Invalid role: ${role}. Use student or soultee.`);
  }

  return [{ uid, role }];
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (!admin.apps.length) {
    throw new Error("Firebase Admin is not initialized. Check firebase-service-account.json.");
  }

  let targets;
  try {
    targets = normalizeItems(args);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    printUsage();
    process.exit(1);
  }

  const firestore = admin.firestore();
  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(`\n🔎 Role fix mode: ${mode}`);
  console.log(`Targets: ${targets.length}\n`);

  let unchanged = 0;
  let updated = 0;
  let missing = 0;
  let invalid = 0;

  for (const target of targets) {
    const { uid, role } = target;

    if (!ALLOWED_ROLES.has(role)) {
      invalid += 1;
      console.log(`❌ ${uid} -> invalid target role: ${role}`);
      continue;
    }

    const ref = firestore.collection("users").doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
      missing += 1;
      console.log(`⚠️  ${uid} -> users doc not found (skipped)`);
      continue;
    }

    const data = snap.data() || {};
    const currentRole = String(data.role || "").trim().toLowerCase();

    if (currentRole === role) {
      unchanged += 1;
      console.log(`✅ ${uid} -> already ${role}`);
      continue;
    }

    console.log(`📝 ${uid} -> ${currentRole || "(empty)"} => ${role}`);

    if (args.apply) {
      await ref.set(
        {
          role,
          updatedAt: new Date(),
        },
        { merge: true }
      );
      updated += 1;
      console.log("   applied");
    }
  }

  console.log("\nSummary:");
  console.log(`  unchanged: ${unchanged}`);
  console.log(`  updated:   ${updated}`);
  console.log(`  missing:   ${missing}`);
  console.log(`  invalid:   ${invalid}`);

  if (!args.apply) {
    console.log("\nDry run complete. Re-run with --apply to persist changes.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\n❌ Role fix failed: ${err.message}`);
    process.exit(1);
  });
