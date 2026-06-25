#!/usr/bin/env node
/**
 * migrateMessagesToFirestore.js
 *
 * One-time migration script: copies all MongoDB Message documents into
 * Firestore under  conversations/{roomId}/messages/{messageId}  and
 * writes a conversation metadata document for each room.
 *
 * Run:
 *   node scripts/migrateMessagesToFirestore.js [--dry-run] [--batch=500]
 *
 * Options:
 *   --dry-run   Print what would be written but don't write anything.
 *   --batch=N   Firestore batch size (max 500, default 400).
 *   --from=ISO  Only migrate messages created after this ISO-8601 date.
 *   --room=ID   Only migrate messages for this roomId.
 *
 * Idempotent: re-running skips documents that already exist in Firestore.
 */

import '../config/env.js'; // load .env
import mongoose from 'mongoose';
import admin from 'firebase-admin';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Parse CLI flags ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const BATCH_SZ  = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '400');
const FROM_DATE = args.find(a => a.startsWith('--from='))?.split('=')[1];
const ROOM_ONLY = args.find(a => a.startsWith('--room='))?.split('=')[1];

console.log(`\n🚀  Zeewant MongoDB → Firestore chat migration`);
if (DRY_RUN) console.log('   DRY RUN — no writes will occur');
if (FROM_DATE) console.log(`   From: ${FROM_DATE}`);
if (ROOM_ONLY) console.log(`   Room: ${ROOM_ONLY}`);
console.log();

// ── Firebase Admin SDK ─────────────────────────────────────────────────────
const serviceAccount = require(resolve(__dirname, '../firebase-service-account.json'));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ── MongoDB ────────────────────────────────────────────────────────────────
await mongoose.connect(process.env.MONGODB_URI);
console.log('✓  Connected to MongoDB');

// Import models after Mongoose connects
const { default: Message }           = await import('../models/Message.js');
const { default: StudentSoulteeLink } = await import('../models/StudentSoulteeLink.js');

// ── Migration ──────────────────────────────────────────────────────────────

/** Converts a MongoDB Message doc to a Firestore-compatible plain object. */
function toFirestoreMessage(m) {
  const reactions = {};
  if (Array.isArray(m.reactions)) {
    for (const r of m.reactions) {
      if (!reactions[r.emoji]) reactions[r.emoji] = [];
      reactions[r.emoji].push(r.userId);
    }
  }

  return {
    senderId:             m.senderId          || '',
    senderName:           m.senderName        || '',
    senderRole:           m.senderRole        || '',
    recipientUid:         m.recipientUid      || '',
    text:                 m.text              || null,
    type:                 m.type              || 'text',
    attachmentUrl:        m.attachmentUrl     || null,
    attachmentName:       m.attachmentName    || null,
    attachmentMimeType:   m.attachmentMimeType || null,
    attachmentSize:       m.attachmentSize    || null,
    callType:             m.callType          || null,
    status:               m.status            || 'sent',
    isDeleted:            m.isDeleted         === true,
    deletedForEveryone:   m.deletedForEveryone === true,
    deletedBy:            m.deletedBy         || null,
    deletedAt:            m.deletedAt ? admin.firestore.Timestamp.fromDate(m.deletedAt) : null,
    deletedForUsers:      Array.isArray(m.deletedForUsers) ? m.deletedForUsers : [],
    reactions,
    replyToMessageId:     m.replyToMessageId  || null,
    replyToText:          m.replyToText       || null,
    replyToSenderName:    m.replyToSenderName || null,
    deliveredAt:          m.deliveredAt ? admin.firestore.Timestamp.fromDate(m.deliveredAt) : null,
    readAt:               m.readAt    ? admin.firestore.Timestamp.fromDate(m.readAt)    : null,
    createdAt:            admin.firestore.Timestamp.fromDate(m.createdAt || new Date()),
    updatedAt:            admin.firestore.Timestamp.fromDate(m.updatedAt || m.createdAt || new Date()),
  };
}

let totalMigrated = 0;
let totalSkipped  = 0;
let totalFailed   = 0;

// Iterate rooms
const linkQuery = ROOM_ONLY
  ? StudentSoulteeLink.find({ _id: ROOM_ONLY }).lean()
  : StudentSoulteeLink.find({}).lean();

const links = await linkQuery;
console.log(`   Found ${links.length} rooms to process`);

for (const link of links) {
  const roomId = String(link._id);
  process.stdout.write(`   Room ${roomId} … `);

  // ── Ensure conversation document ──────────────────────────────────────
  const convRef = db.collection('conversations').doc(roomId);
  const convSnap = await convRef.get();
  if (!convSnap.exists && !DRY_RUN) {
    await convRef.set({
      id: roomId,
      studentUid:   link.studentFirebaseUid,
      soulteeUid:   link.soulteeFirebaseUid,
      studentName:  link.studentName  || '',
      solteeName:   link.solteeName   || '',
      status:       link.status       || 'active',
      chatLocked:   link.chatLocked   === true,
      createdAt:    admin.firestore.Timestamp.fromDate(link.createdAt || new Date()),
      updatedAt:    admin.firestore.Timestamp.fromDate(link.updatedAt || link.createdAt || new Date()),
      unreadCounts: {
        [link.studentFirebaseUid]: 0,
        [link.soulteeFirebaseUid]: 0,
      },
    }, { merge: true });
  }

  // ── Fetch MongoDB messages for this room ──────────────────────────────
  const msgQuery = { roomId };
  if (FROM_DATE) msgQuery.createdAt = { $gte: new Date(FROM_DATE) };
  const messages = await Message.find(msgQuery).sort({ createdAt: 1 }).lean();

  if (messages.length === 0) {
    console.log('no messages');
    continue;
  }

  // ── Write in batches ─────────────────────────────────────────────────
  let roomMigrated = 0;
  let roomSkipped  = 0;
  const msgsCol = db.collection('conversations').doc(roomId).collection('messages');

  for (let i = 0; i < messages.length; i += BATCH_SZ) {
    const chunk = messages.slice(i, i + BATCH_SZ);
    const batch = db.batch();
    let batchCount = 0;

    for (const m of chunk) {
      const docId  = String(m._id);
      const docRef = msgsCol.doc(docId);

      // Skip if already migrated (idempotency)
      const existing = await docRef.get();
      if (existing.exists) {
        roomSkipped++;
        totalSkipped++;
        continue;
      }

      if (!DRY_RUN) {
        batch.set(docRef, toFirestoreMessage(m));
      }
      batchCount++;
      roomMigrated++;
      totalMigrated++;
    }

    if (batchCount > 0 && !DRY_RUN) {
      await batch.commit();
    }
  }

  // ── Update lastMessage on conversation document ───────────────────────
  if (!DRY_RUN && messages.length > 0) {
    const last = messages[messages.length - 1];
    await convRef.set({
      lastMessage: {
        id:        String(last._id),
        text:      last.text || last.attachmentName || last.type,
        type:      last.type || 'text',
        senderId:  last.senderId,
        createdAt: admin.firestore.Timestamp.fromDate(last.createdAt || new Date()),
      },
      updatedAt: admin.firestore.Timestamp.fromDate(last.updatedAt || last.createdAt || new Date()),
    }, { merge: true });
  }

  console.log(`migrated=${roomMigrated} skipped=${roomSkipped}`);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n✅  Migration complete`);
console.log(`   Migrated : ${totalMigrated}`);
console.log(`   Skipped  : ${totalSkipped} (already in Firestore)`);
console.log(`   Failed   : ${totalFailed}`);
if (DRY_RUN) console.log('\n   (DRY RUN — no data was written)');

await mongoose.disconnect();
process.exit(0);
