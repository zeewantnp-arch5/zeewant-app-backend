import jwt from "jsonwebtoken";

/**
 * Generate a Jitsi Meet JWT that grants the user moderator access.
 * Moderator role bypasses the lobby entirely — no "waiting for moderator" dialog.
 *
 * Required env vars:
 *   JITSI_APP_ID     — your Jitsi / JaaS application ID (e.g. "vpaas-magic-cookie-xxx")
 *   JITSI_SECRET     — your Jitsi / JaaS API key secret
 *   JITSI_DOMAIN     — your Jitsi server domain (e.g. "8x8.vc" for JaaS, or "meet.jit.si")
 *
 * Returns null when env vars are not set so callers on public servers can still work
 * without a token (lobby must be disabled server-side in that case).
 */
export function generateJitsiToken({
  userId,
  userName,
  userEmail,
  roomName,
  isModerator = true,
  ttlSeconds = 7200, // 2 hours
}) {
  const appId = process.env.JITSI_APP_ID;
  const secret = process.env.JITSI_SECRET;
  const domain = process.env.JITSI_DOMAIN || "meet.jit.si";

  if (!appId || !secret) {
    // JWT not configured — return null so socket events still work on public Jitsi
    return null;
  }

  const payload = {
    context: {
      user: {
        id: userId,
        name: userName || userId,
        email: userEmail || `${userId}@zeewant.app`,
        moderator: isModerator,
      },
      features: {
        livestreaming: false,
        "outbound-call": false,
        transcription: false,
        recording: false,
      },
    },
    aud: appId,
    iss: appId,
    sub: domain,
    room: roomName || "*",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nbf: Math.floor(Date.now() / 1000) - 10,
  };

  return jwt.sign(payload, secret, { algorithm: "HS256" });
}

/**
 * Build the full Jitsi server URL for a room.
 * Flutter uses this as the base URL when launching jitsi_meet.
 */
export function buildJitsiServerUrl() {
  const domain = process.env.JITSI_DOMAIN || "meet.jit.si";
  return `https://${domain}`;
}
