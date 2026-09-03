import { describe, expect, test } from "bun:test";
import {
  fixedWebCodecsCodec,
  isRawVideoKeyFrame,
  isWebCodecsUnsupportedError,
  mseFallbackCodecError,
  parseVideoSession,
  resolveVideoKeyFrame,
  videoCodecLabel,
  webRtcCodecError,
  webCodecsCodec,
  webCodecsHardwareAcceleration,
} from "../src/ui/lib/video-codec.ts";

describe("WebSocket video codec helpers", () => {
  test("parses authoritative codec generation boundaries", () => {
    expect(
      parseVideoSession({
        type: "video-session",
        size: { width: 1080, height: 2400 },
        codec: "vp9",
      }),
    ).toEqual({ size: { width: 1080, height: 2400 }, codec: "vp9" });

    for (const invalid of [
      { type: "video-session", size: { width: 1080, height: 2400 } },
      {
        type: "video-session",
        size: { width: 1080, height: 2400 },
        codec: "av1",
      },
      {
        type: "video-session",
        size: { width: 0, height: 2400 },
        codec: "vp8",
      },
      {
        type: "video-session",
        size: { width: 1080, height: Number.NaN },
        codec: "h264",
      },
    ]) {
      expect(parseVideoSession(invalid)).toBeNull();
    }
  });

  test("uses registered WebCodecs codec strings and SPS-derived AVC profiles", () => {
    expect(fixedWebCodecsCodec("h264")).toBeNull();
    expect(fixedWebCodecsCodec("vp8")).toBe("vp8");
    expect(fixedWebCodecsCodec("vp9")).toBe("vp09.00.10.08");
    expect(webCodecsCodec("h264", Uint8Array.of(0x67, 0x64, 0, 0x29))).toBe(
      "avc1.640029",
    );
    expect(webCodecsCodec("h264", Uint8Array.of(0x67, 0x64))).toBeNull();
    expect(webCodecsHardwareAcceleration("h264")).toBe("prefer-hardware");
    expect(webCodecsHardwareAcceleration("vp8")).toBe("no-preference");
    expect(webCodecsHardwareAcceleration("vp9")).toBe("no-preference");
    expect(videoCodecLabel("h264")).toBe("H.264");
    expect(videoCodecLabel("vp9")).toBe("VP9");
    expect(mseFallbackCodecError("h264")).toBeNull();
    expect(mseFallbackCodecError("vp8")).toBe(
      "VP8 WebSocket video requires WebCodecs; the MSE fallback only supports H.264",
    );
    expect(webRtcCodecError("h264")).toBeNull();
    expect(webRtcCodecError("vp9")).toBe(
      "VP9 gRPC video is WebSocket-only. Select H.264 to use WebRTC.",
    );
    expect(isWebCodecsUnsupportedError({ name: "NotSupportedError" })).toBe(
      true,
    );
    expect(isWebCodecsUnsupportedError(new Error("decode failed"))).toBe(
      false,
    );
  });

  test("recognizes complete raw VP8 and VP9 keyframe headers", () => {
    const vp8Key = Uint8Array.of(
      0xf0,
      0x02,
      0,
      0x9d,
      0x01,
      0x2a,
      0x10,
      0,
      0x10,
      0,
    );
    const vp9Key = Uint8Array.of(0x82, 0x49, 0x83, 0x42);

    expect(isRawVideoKeyFrame("vp8", vp8Key)).toBe(true);
    expect(isRawVideoKeyFrame("vp8", Uint8Array.of(0xb1, 1, 0, 5))).toBe(
      false,
    );
    expect(
      isRawVideoKeyFrame(
        "vp8",
        Uint8Array.of(0, 0, 0, 0x9d, 0x01, 0x2a),
      ),
    ).toBe(false);
    expect(isRawVideoKeyFrame("vp9", vp9Key)).toBe(true);
    expect(isRawVideoKeyFrame("vp9", Uint8Array.of(0x86, 0, 0x40, 0x92))).toBe(
      false,
    );
    expect(isRawVideoKeyFrame("vp9", Uint8Array.of(0x82, 0, 0, 0))).toBe(
      false,
    );
    expect(isRawVideoKeyFrame("vp9", Uint8Array.of(0x82))).toBe(false);
  });

  test("uses SEMU key metadata without inspecting misleading payload bytes", () => {
    const vp8Key = Uint8Array.of(
      0xf0,
      0x02,
      0,
      0x9d,
      0x01,
      0x2a,
      0x10,
      0,
      0x10,
      0,
    );
    const invalid = Uint8Array.of(1, 2, 3);

    expect(resolveVideoKeyFrame("vp8", false, vp8Key)).toBe(false);
    expect(resolveVideoKeyFrame("vp9", true, invalid)).toBe(true);
    expect(resolveVideoKeyFrame("vp8", null, vp8Key)).toBe(true);
  });
});
