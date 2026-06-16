import { AccessToken } from "livekit-server-sdk";

/**
 * Generate a LiveKit access token granting publish + subscribe rights.
 *
 * Required env vars:
 *   LIVEKIT_API_KEY    — LiveKit server API key
 *   LIVEKIT_API_SECRET — LiveKit server API secret
 *   LIVEKIT_URL        — wss:// URL of your LiveKit server (e.g. wss://your-server.livekit.cloud)
 *
 * Returns null when env vars are absent so callers can surface a clear error.
 */
export function generateLiveKitToken({
  roomName,
  participantIdentity,
  participantName,
  ttlSeconds = 7200,
}) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return null;
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity,
    name: participantName || participantIdentity,
    ttl: `${ttlSeconds}s`,
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  return at.toJwt();
}

export function getLiveKitUrl() {
  return process.env.LIVEKIT_URL || "";
}
