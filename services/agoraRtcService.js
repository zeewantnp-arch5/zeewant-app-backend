import pkg from "agora-token";
const { RtcTokenBuilder, RtcRole } = pkg;

/**
 * Generate an Agora RTC token for a 1-to-1 voice call channel.
 *
 * Uses the same AGORA_APP_ID / AGORA_APP_CERTIFICATE env vars as Agora Chat.
 *
 * @param {string} channelName  - Agora channel name (UUID per call)
 * @param {number} uid          - Numeric UID (0 = Agora auto-assigns)
 * @param {number} expirySeconds - Token lifetime (default 3600 = 1 hour)
 * @returns {{ token: string, appId: string, channel: string, uid: number } | null}
 */
export function generateAgoraRtcToken(channelName, uid = 0, expirySeconds = 3600) {
  const appId   = process.env.AGORA_APP_ID;
  const appCert = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCert) {
    console.error("[AgoraRTC] AGORA_APP_ID or AGORA_APP_CERTIFICATE not set in env");
    return null;
  }

  if (!channelName) {
    console.error("[AgoraRTC] channelName is required");
    return null;
  }

  const privilegeExpiredTs = Math.floor(Date.now() / 1000) + expirySeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCert,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
    );
    console.log(`[AgoraRTC] token generated — channel=${channelName} uid=${uid}`);
    return { token, appId, channel: channelName, uid };
  } catch (err) {
    console.error(`[AgoraRTC] token generation failed: ${err.message}`);
    return null;
  }
}

export function getAgoraAppId() {
  return process.env.AGORA_APP_ID || "";
}
