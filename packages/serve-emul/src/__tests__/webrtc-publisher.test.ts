import { describe, expect, test } from "bun:test";
import { injectVideoSsrc, selectH264Media } from "../webrtc-publisher.ts";

describe("WebRTC publisher SDP helpers", () => {
  test("selects a browser-offered H.264 packetization-mode=1 payload type", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96 110 109",
          "a=mid:video0",
          "a=rtpmap:96 VP8/90000",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "video0" });
  });

  test("prefers constrained baseline H.264 when multiple compatible payloads exist", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 111 109",
          "a=mid:0",
          "a=rtpmap:111 H264/90000",
          "a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "0" });
  });

  test("rejects offers without packetization-mode=1 H.264 video", () => {
    expect(() =>
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 110",
          "a=mid:video0",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
        ].join("\r\n"),
      ),
    ).toThrow("WebRTC offer does not include H.264 packetization-mode=1 video");
  });

  test("injects the selected SSRC into the matching video section", () => {
    const answer = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:audio0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=sendonly",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "a=mid:audio0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=sendonly",
      ].join("\r\n"),
    );
  });

  test("adds the exact packetizer SSRC even when other SSRC lines exist", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:9999 cname:old",
    ].join("\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=ssrc:9999 cname:old",
      ].join("\n"),
    );
  });

  test("leaves SDP unchanged when the exact SSRC is already present", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:1234 cname:serve-emu",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(answer);
  });
});
