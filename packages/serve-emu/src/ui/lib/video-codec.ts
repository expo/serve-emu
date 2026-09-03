import type { GrpcVideoCodec } from "../../shared/api-contracts";
import { buildCodecString, scanAU } from "./h264";

export type VideoSession = {
  size: { width: number; height: number };
  codec: GrpcVideoCodec;
};

export function isGrpcVideoCodec(value: unknown): value is GrpcVideoCodec {
  return value === "h264" || value === "vp8" || value === "vp9";
}

/** Parse the generation boundary that precedes every encoded WebSocket stream. */
export function parseVideoSession(value: unknown): VideoSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "video-session" ||
    !isGrpcVideoCodec(candidate.codec) ||
    !candidate.size ||
    typeof candidate.size !== "object" ||
    Array.isArray(candidate.size)
  ) {
    return null;
  }
  const size = candidate.size as Record<string, unknown>;
  if (
    typeof size.width !== "number" ||
    !Number.isFinite(size.width) ||
    size.width <= 0 ||
    typeof size.height !== "number" ||
    !Number.isFinite(size.height) ||
    size.height <= 0
  ) {
    return null;
  }
  return {
    size: { width: size.width, height: size.height },
    codec: candidate.codec,
  };
}

/**
 * Return the WebCodecs codec string when it does not depend on in-band data.
 * H.264's profile, constraints, and level must still be derived from its SPS.
 */
export function fixedWebCodecsCodec(codec: GrpcVideoCodec): string | null {
  if (codec === "vp8") return "vp8";
  if (codec === "vp9") return "vp09.00.10.08";
  return null;
}

export function webCodecsCodec(
  codec: GrpcVideoCodec,
  h264Sps: Uint8Array | null = null,
): string | null {
  if (codec !== "h264") return fixedWebCodecsCodec(codec);
  return h264Sps && h264Sps.byteLength >= 4
    ? buildCodecString(h264Sps)
    : null;
}

/**
 * Chrome on macOS commonly exposes VP8 through software decode only. Requiring
 * a hardware path makes an otherwise supported VP8 configuration fail.
 */
export function webCodecsHardwareAcceleration(
  codec: GrpcVideoCodec,
): "prefer-hardware" | "no-preference" {
  return codec === "h264" ? "prefer-hardware" : "no-preference";
}

export function videoCodecLabel(codec: GrpcVideoCodec): string {
  return codec === "h264" ? "H.264" : codec.toUpperCase();
}

/** Report why a codec cannot use the browser's non-WebCodecs fallback. */
export function mseFallbackCodecError(
  codec: GrpcVideoCodec,
  mseSupported = true,
): string | null {
  if (codec !== "h264") {
    return `${videoCodecLabel(codec)} WebSocket video requires WebCodecs; the MSE fallback only supports H.264`;
  }
  return mseSupported
    ? null
    : "WebCodecs unavailable and H.264 MSE unsupported";
}

/** gRPC VPx output is an elementary WebSocket stream, not a WebRTC source. */
export function webRtcCodecError(codec: GrpcVideoCodec): string | null {
  return codec === "h264"
    ? null
    : `${videoCodecLabel(codec)} gRPC video is WebSocket-only. Select H.264 to use WebRTC.`;
}

export function isWebCodecsUnsupportedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotSupportedError"
  );
}

class BitReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(bits: number): number | null {
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > 31) return null;
    if (this.#offset + bits > this.bytes.byteLength * 8) return null;
    let value = 0;
    for (let index = 0; index < bits; index++) {
      const position = this.#offset++;
      value =
        value * 2 +
        ((this.bytes[position >> 3]! >> (7 - (position & 7))) & 1);
    }
    return value;
  }
}

function isRawVp8KeyFrame(data: Uint8Array): boolean {
  // A VP8 keyframe has the key bit cleared and the mandatory 0x9d012a start
  // code. Requiring its complete ten-byte uncompressed header avoids treating
  // arbitrary short control/config data as an independently decodable frame.
  return (
    data.byteLength >= 10 &&
    (data[0]! & 1) === 0 &&
    data[3] === 0x9d &&
    data[4] === 0x01 &&
    data[5] === 0x2a
  );
}

function isRawVp9KeyFrame(data: Uint8Array): boolean {
  const bits = new BitReader(data);
  if (bits.read(2) !== 0b10) return false; // frame marker
  const profileLow = bits.read(1);
  const profileHigh = bits.read(1);
  if (profileLow === null || profileHigh === null) return false;
  const profile = profileLow | (profileHigh << 1);
  if (profile === 3 && bits.read(1) !== 0) return false; // reserved zero
  if (bits.read(1) !== 0) return false; // show_existing_frame
  if (bits.read(1) !== 0) return false; // frame_type: 0 is keyframe
  if (bits.read(1) === null || bits.read(1) === null) return false; // show_frame + error_resilient_mode
  return bits.read(24) === 0x498342; // mandatory frame sync code
}

/** Detect a keyframe in a raw, metadata-free encoded access unit. */
export function isRawVideoKeyFrame(
  codec: GrpcVideoCodec,
  data: Uint8Array,
): boolean {
  if (codec === "h264") return scanAU(data).isKey;
  if (codec === "vp8") return isRawVp8KeyFrame(data);
  return isRawVp9KeyFrame(data);
}

/** SEMU's key bit is authoritative; inspect bytes only for legacy raw frames. */
export function resolveVideoKeyFrame(
  codec: GrpcVideoCodec,
  metadataKey: boolean | null,
  data: Uint8Array,
): boolean {
  return metadataKey ?? isRawVideoKeyFrame(codec, data);
}
