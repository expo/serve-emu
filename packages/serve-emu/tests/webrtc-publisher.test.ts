import { describe, expect, test } from "bun:test";
import { injectVideoSsrc, selectH264Media } from "../src/webrtc-publisher.ts";

const sdp = (lines: string[]): string => lines.join("\r\n");

describe("selectH264Media", () => {
  test("picks the offer's mid and the packetization-mode=1 constrained-baseline H264 payload type", () => {
    // Trimmed-down version of a real Chrome offer: PT 96 is VP8, and H264
    // appears with several profiles. 109 is packetization-mode=1 +
    // profile 42e0 (constrained baseline) — the best match for our packetizer.
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 103 107 109 117",
      "a=mid:0",
      "a=recvonly",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:103 H264/90000",
      "a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
      "a=rtpmap:107 H264/90000",
      "a=fmtp:107 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
      "a=rtpmap:109 H264/90000",
      "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:117 H264/90000",
      "a=fmtp:117 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=mid:1",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 109, mid: "0" });
  });

  test("never picks VP8's payload type even though it is listed first", () => {
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 103",
      "a=mid:0",
      "a=rtpmap:96 VP8/90000",
      "a=rtpmap:103 H264/90000",
      "a=fmtp:103 packetization-mode=1;profile-level-id=42001f",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 103, mid: "0" });
  });

  test("prefers packetization-mode=1 over a better profile with packetization-mode=0", () => {
    // 115 has the preferred profile (42e0) but mode=0; 103 has a lesser
    // profile (4200) but mode=1. Our packetizer emits mode=1 packets, so
    // mode compatibility must win over profile preference.
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 103 115",
      "a=mid:0",
      "a=rtpmap:103 H264/90000",
      "a=fmtp:103 packetization-mode=1;profile-level-id=42001f",
      "a=rtpmap:115 H264/90000",
      "a=fmtp:115 packetization-mode=0;profile-level-id=42e01f",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 103, mid: "0" });
  });

  test("returns the mid as the browser named it, not a hardcoded value", () => {
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 103",
      "a=mid:sdparta_2",
      "a=rtpmap:103 H264/90000",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 103, mid: "sdparta_2" });
  });

  test("falls back to the only H264 payload type when the offer has no fmtp lines", () => {
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 103",
      "a=mid:0",
      "a=rtpmap:103 H264/90000",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 103, mid: "0" });
  });

  test("ignores rtpmap/mid lines outside the m=video section", () => {
    // The audio section's mid ("wrong") and codec lines come first; only the
    // video section may be used.
    const offer = sdp([
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:wrong",
      "a=rtpmap:111 opus/48000/2",
      "m=video 9 UDP/TLS/RTP/SAVPF 103",
      "a=mid:right",
      "a=rtpmap:103 H264/90000",
    ]);

    expect(selectH264Media(offer)).toEqual({ payloadType: 103, mid: "right" });
  });

  test("throws when the offer has video but no H264 codec", () => {
    const offer = sdp([
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:0",
      "a=rtpmap:96 VP8/90000",
    ]);

    expect(() => selectH264Media(offer)).toThrow(
      "WebRTC offer does not include an H.264 video media section",
    );
  });

  test("throws when the offer has no video section at all", () => {
    const offer = sdp([
      "v=0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=mid:0",
    ]);

    expect(() => selectH264Media(offer)).toThrow(
      "WebRTC offer does not include an H.264 video media section",
    );
  });
});

describe("injectVideoSsrc", () => {
  test("inserts an a=ssrc line directly after the video section's a=mid line", () => {
    const answerWithoutSsrc = sdp([
      "v=0",
      "m=video 52050 UDP/TLS/RTP/SAVPF 109",
      "a=mid:0",
      "a=sendonly",
      "a=rtpmap:109 H264/90000",
    ]);

    const expected = sdp([
      "v=0",
      "m=video 52050 UDP/TLS/RTP/SAVPF 109",
      "a=mid:0",
      "a=ssrc:42424242 cname:serve-emu",
      "a=sendonly",
      "a=rtpmap:109 H264/90000",
    ]);

    expect(injectVideoSsrc(answerWithoutSsrc, "0", 42424242)).toBe(expected);
  });

  test("leaves the SDP unchanged when an a=ssrc line is already present", () => {
    const answerWithSsrc = sdp([
      "v=0",
      "m=video 52050 UDP/TLS/RTP/SAVPF 109",
      "a=mid:0",
      "a=ssrc:7 cname:already-there",
      "a=sendonly",
    ]);

    expect(injectVideoSsrc(answerWithSsrc, "0", 42424242)).toBe(answerWithSsrc);
  });

  test("leaves the SDP unchanged when the mid does not exist", () => {
    const answer = sdp([
      "v=0",
      "m=video 52050 UDP/TLS/RTP/SAVPF 109",
      "a=mid:0",
      "a=sendonly",
    ]);

    expect(injectVideoSsrc(answer, "no-such-mid", 42424242)).toBe(answer);
  });
});
