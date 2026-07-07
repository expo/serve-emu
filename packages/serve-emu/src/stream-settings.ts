export type WebRtcIceTransportPolicy = "all" | "relay";

export type WebRtcIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type StreamSettings =
  | { transport: "websocket" }
  | {
      transport: "webrtc";
      codec: "h264";
      iceServers: WebRtcIceServer[];
      iceTransportPolicy: WebRtcIceTransportPolicy;
    };

export const DEFAULT_WEBRTC_ICE_SERVERS: WebRtcIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];

export function redactedStreamSettings(settings: StreamSettings): StreamSettings {
  if (settings.transport !== "webrtc") return settings;
  return {
    ...settings,
    iceServers: settings.iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: "redacted" } : {}),
    })),
  };
}
