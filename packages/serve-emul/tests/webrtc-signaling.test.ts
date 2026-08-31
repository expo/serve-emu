import { describe, expect, test } from "bun:test";
import {
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
} from "../src/webrtc-signaling.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

describe("WebRTC signaling validation", () => {
  test("accepts an H.264 offer", () => {
    expect(
      parseWebRtcOffer({
        type: "offer",
        sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 109\r\n",
        sessionId: SESSION_ID,
        codec: "h264",
      }),
    ).toEqual({
      type: "offer",
      sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 109\r\n",
      sessionId: SESSION_ID,
      codec: "h264",
    });
  });

  test("rejects unsupported codecs and client-supplied ICE servers", () => {
    expect(() =>
      parseWebRtcOffer({
        type: "offer",
        sdp: "v=0",
        sessionId: SESSION_ID,
        codec: "vp8",
      }),
    ).toThrow(WebRtcSignalingError);
    expect(() =>
      parseWebRtcOffer({
        type: "offer",
        sdp: "v=0",
        sessionId: SESSION_ID,
        iceServers: [{ urls: ["turn:turn.example:3478"] }],
      }),
    ).toThrow("ICE servers must be configured by the serve-emul host");
  });

  test("requires valid UUID session IDs", () => {
    expect(() =>
      parseWebRtcOffer({
        type: "offer",
        sdp: "v=0",
        sessionId: "not-a-uuid",
      }),
    ).toThrow("Invalid WebRTC session ID");
    expect(parseWebRtcCloseRequest({ sessionId: SESSION_ID })).toEqual({ sessionId: SESSION_ID });
  });

  test("bounds the offer SDP size", () => {
    expect(() =>
      parseWebRtcOffer({
        type: "offer",
        sdp: "v".repeat(241 * 1024),
        sessionId: SESSION_ID,
      }),
    ).toThrow("Invalid WebRTC offer SDP");
  });
});
