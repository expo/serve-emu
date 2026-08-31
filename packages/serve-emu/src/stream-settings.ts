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

export const DEFAULT_STREAM_SETTINGS: StreamSettings = { transport: "websocket" };

export function parseIceUrlList(value: string, kind: "stun" | "turn"): string[] {
  const urls = value.split(",").map((url) => url.trim()).filter(Boolean);
  const scheme = kind === "stun" ? /^stuns?:/i : /^turns?:/i;
  if (urls.length === 0 || urls.length > 16 || urls.some((url) => url.length > 2_048 || !scheme.test(url))) {
    throw new Error(`Expected one or more comma-separated ${kind.toUpperCase()} URLs`);
  }
  return urls;
}

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
