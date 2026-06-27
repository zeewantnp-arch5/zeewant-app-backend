import pkg from "agora-token";
const { ChatTokenBuilder } = pkg;

const APP_ID          = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
const ORG_NAME        = process.env.AGORA_CHAT_ORG_NAME;
const APP_NAME        = process.env.AGORA_CHAT_APP_NAME;
const CLIENT_ID       = process.env.AGORA_CHAT_CLIENT_ID;
const CLIENT_SECRET   = process.env.AGORA_CHAT_CLIENT_SECRET;
const REST_URL        = process.env.AGORA_CHAT_REST_URL || "https://a61.chat.agora.io";


const BASE_URL = `${REST_URL}/${ORG_NAME}/${APP_NAME}`;

// Cached admin token — refreshed automatically before expiry
let _adminToken        = null;
let _adminTokenExpiry  = 0;

// ── Admin REST token (client-credentials grant) ───────────────────────────────
async function getAdminToken() {
  if (_adminToken && Date.now() < _adminTokenExpiry) return _adminToken;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("AGORA_CHAT_CLIENT_ID and AGORA_CHAT_CLIENT_SECRET must be set in .env");
  }

  const res = await fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type:    "client_credentials",
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Agora Chat admin token failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _adminToken       = data.access_token;
  // Subtract 60 s buffer so we refresh before the server rejects the token
  _adminTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _adminToken;
}

// ── Register a user in Agora Chat (idempotent — 409 means already exists) ────
export async function registerAgoraChatUser(uid) {
  if (!uid) return;
  const token    = await getAdminToken();
  const agoraUid = uid.toLowerCase();

  const res = await fetch(`${BASE_URL}/users`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${token}`,
    },
    body: JSON.stringify([
      // Agora Chat requires a password; we use a deterministic placeholder
      // that is never used for login (the app always uses token auth).
      { username: agoraUid, password: `Zw${uid.slice(0, 6)}!` },
    ]),
  });

  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    console.error(`[AgoraChat] user registration failed (${res.status}): ${text}`);
  }
}

// ── Generate a 24-hour user access token for the Flutter SDK ─────────────────
export function generateAgoraChatToken(uid) {
  if (!APP_ID || !APP_CERTIFICATE) {
    throw new Error("AGORA_APP_ID and AGORA_APP_CERTIFICATE must be set in .env");
  }
  const EXPIRE_SECONDS = 86400; // 24 hours
  return ChatTokenBuilder.buildUserToken(
    APP_ID,
    APP_CERTIFICATE,
    uid.toLowerCase(),
    EXPIRE_SECONDS,
  );
}

// ── Send a custom message to a peer via Agora Chat REST API ─────────────────
// This replaces the Socket.IO `new_message` broadcast.  The recipient's
// Flutter SDK receives it via `ChatEventHandler.onMessagesReceived`.
//
// payload  = the full serialized MongoDB message object (from serializeMessage)
// fromUid  = sender Firebase UID  (lowercased for Agora)
// toUid    = recipient Firebase UID (lowercased for Agora)
export async function sendAgoraChatMessage({ fromUid, toUid, payload }) {
  if (!ORG_NAME || !APP_NAME) {
    // Agora not configured yet — skip silently so existing features keep working
    return;
  }

  try {
    const token = await getAdminToken();

    // All values in customExts must be strings (Agora Chat SDK restriction).
    // Nullable fields are sent as empty string so Flutter can distinguish.
    const customExts = {
      _id:                String(payload._id         ?? ""),
      roomId:             String(payload.roomId       ?? ""),
      senderId:           String(payload.senderId     ?? ""),
      senderName:         String(payload.senderName   ?? ""),
      senderRole:         String(payload.senderRole   ?? ""),
      type:               String(payload.type         ?? "text"),
      text:               String(payload.text         ?? ""),
      attachmentUrl:      String(payload.attachmentUrl   ?? ""),
      attachmentName:     String(payload.attachmentName  ?? ""),
      attachmentMimeType: String(payload.attachmentMimeType ?? ""),
      attachmentSize:     String(payload.attachmentSize    ?? ""),
      callType:           String(payload.callType     ?? ""),
      replyToMessageId:   String(payload.replyToMessageId   ?? ""),
      replyToText:        String(payload.replyToText        ?? ""),
      replyToSenderName:  String(payload.replyToSenderName  ?? ""),
      createdAt:          String(payload.createdAt ?? new Date().toISOString()),
      status:             "sent",
      deletedForEveryone: "false",
    };

    const body = {
      from: fromUid.toLowerCase(),
      to:   [toUid.toLowerCase()],
      type: "custom",
      body: {
        type:        "custom",
        customEvent: "zeewant_message",
        customExts,
      },
    };

    const res = await fetch(`${BASE_URL}/messages/users`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[AgoraChat] send message failed (${res.status}): ${text}`);
    }
  } catch (err) {
    // Non-fatal — message is already persisted in MongoDB; delivery will be
    // retried by Agora Chat's own offline queuing when the recipient reconnects.
    console.error("[AgoraChat] sendAgoraChatMessage error:", err.message);
  }
}

// ── Send a system/call message to a peer (e.g. missed-call notification) ─────
export async function sendAgoraChatSystemMessage({ fromUid, toUid, payload }) {
  return sendAgoraChatMessage({ fromUid, toUid, payload });
}
