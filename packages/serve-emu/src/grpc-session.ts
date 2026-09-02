import { setTimeout as delay } from "node:timers/promises";
import {
  ControlInputQueue,
  ControlInputRejectedError,
} from "./control-input-queue.ts";
import { isEmulatorSerial } from "./device-capabilities.ts";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
  IMG_FORMAT_PNG,
  IMG_FORMAT_RGB888,
  type EmuImage,
  type GrpcEndpoint,
  type GrpcScreenshotImageSource,
  type ImageFormatRequest,
  type KeyboardEventRequest,
  type TouchPoint,
} from "./emulator-grpc.ts";
import { execText, type ExecResult } from "./exec.ts";
import {
  H264Encoder,
  assertFfmpegAvailable,
  type H264EncoderOpts,
  type QuarterTurn,
} from "./h264-encoder.ts";
import { H264StartupGate } from "./h264-readiness.ts";
import {
  normalizeTextForControl,
  type Gesture,
} from "./input.ts";
import {
  SCRCPY_DEFAULTS,
  type StartOpts,
  type VideoFrame,
  type VideoPacket,
} from "./scrcpy.ts";
import type {
  EmuSession,
  StreamFailure,
  StreamMeta,
} from "./stream-session.ts";

export { H264StartupGate } from "./h264-readiness.ts";

// Annex-B does not expose the final access-unit length. Submit one duplicate
// RGB frame only after the observed source cadence goes idle, so ffmpeg emits
// the preceding frame at a real AUD boundary. Parsing stdout merely because it
// went idle is unsafe.
const ACCESS_UNIT_BOUNDARY_IDLE_INTERVALS = 1.5;
const ACCESS_UNIT_BOUNDARY_STARTUP_DELAY_MS = 100;
const ACCESS_UNIT_BOUNDARY_MAX_DELAY_MS = 250;
const ACCESS_UNIT_CADENCE_WINDOW = 8;
const ACCESS_UNIT_CADENCE_OUTLIER_FLOOR_MS = 250;
const ACCESS_UNIT_CADENCE_OUTLIER_MULTIPLIER = 4;
const ACCESS_UNIT_SLOW_CADENCE_SIMILARITY = 1.5;
const ENCODER_WRITE_RETRY_DELAY_MS = 8;
const DEFAULT_IDLE_REPEAT_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_QUEUED_PACKET_BYTES = 64 * 1024 * 1024;
const DISPLAY_SIZE_POLL_MS = 2_000;
const MAX_DISPLAY_SIZE_OUTPUT_BYTES = 4_096;
const INPUT_RELEASE_TIMEOUT_MS = 500;
const TOUCH_PRESSURE = 1;

const ANDROID_KEYCODE_TO_EVDEV: Record<number, number> = {
  19: 103,
  20: 108,
  21: 105,
  22: 106,
  24: 115,
  25: 114,
  61: 15,
  66: 28,
  67: 14,
  92: 104,
  93: 109,
  111: 1,
  112: 111,
  122: 102,
  123: 107,
  164: 113,
};

const ANDROID_PRINTABLE_KEYCODE_TO_W3C: Record<number, string> = {
  55: ",",
  56: ".",
  62: " ",
  68: "`",
  69: "-",
  70: "=",
  71: "[",
  72: "]",
  73: "\\",
  74: ";",
  75: "'",
  76: "/",
  77: "@",
  81: "+",
};

const ANDROID_SPECIAL_KEYCODE_TO_W3C: Record<number, string> = {
  3: "GoHome",
  4: "GoBack",
  26: "Power",
  187: "AppSwitch",
};

const ANDROID_META = {
  shift: 0x0000_0001,
  alt: 0x0000_0002,
  altLeft: 0x0000_0010,
  altRight: 0x0000_0020,
  shiftLeft: 0x0000_0040,
  shiftRight: 0x0000_0080,
  ctrl: 0x0000_1000,
  ctrlLeft: 0x0000_2000,
  ctrlRight: 0x0000_4000,
  meta: 0x0001_0000,
  metaLeft: 0x0002_0000,
  metaRight: 0x0004_0000,
} as const;

const SUPPORTED_ANDROID_META_MASK = Object.values(ANDROID_META).reduce(
  (mask, value) => mask | value,
  0,
);

type AndroidKeyGesture = Extract<Gesture, { type: "key" }>;

function modifierKeyRequests(metaState: number): KeyboardEventRequest[] {
  const unsupported = metaState & ~SUPPORTED_ANDROID_META_MASK;
  if (unsupported !== 0) {
    throw new ControlInputRejectedError(
      `grpc-screenshot cannot encode Android key metaState bits 0x${unsupported.toString(16)}`,
    );
  }

  const modifiers: KeyboardEventRequest[] = [];
  const addGroup = (
    generic: number,
    left: number,
    right: number,
    leftEvdev: number,
    rightEvdev: number,
  ) => {
    const hasLeft = (metaState & left) !== 0;
    const hasRight = (metaState & right) !== 0;
    if (hasLeft) modifiers.push({ evdev: leftEvdev, eventType: "down" });
    if (hasRight) modifiers.push({ evdev: rightEvdev, eventType: "down" });
    if (!hasLeft && !hasRight && (metaState & generic) !== 0) {
      modifiers.push({ evdev: leftEvdev, eventType: "down" });
    }
  };

  addGroup(
    ANDROID_META.shift,
    ANDROID_META.shiftLeft,
    ANDROID_META.shiftRight,
    42,
    54,
  );
  addGroup(
    ANDROID_META.ctrl,
    ANDROID_META.ctrlLeft,
    ANDROID_META.ctrlRight,
    29,
    97,
  );
  addGroup(
    ANDROID_META.alt,
    ANDROID_META.altLeft,
    ANDROID_META.altRight,
    56,
    100,
  );
  addGroup(
    ANDROID_META.meta,
    ANDROID_META.metaLeft,
    ANDROID_META.metaRight,
    125,
    126,
  );
  return modifiers;
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

function throwIfAborted(signal: AbortSignal, fallback: string): void {
  if (signal.aborted) throw abortReason(signal, fallback);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(Math.max(0, ms), undefined, { signal });
}

function commandFailure(
  description: string,
  result: ExecResult<string>,
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    `status ${result.status ?? "unknown"}`;
  return new Error(`${description}: ${detail}`);
}

async function runPowerCommand(
  serial: string,
  action: "sleep" | "wakeup",
  signal: AbortSignal,
): Promise<void> {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "cmd", "power", action],
    { timeout: 5_000, signal, lane: "interactive" },
  );
  if (result.status !== 0) {
    throw commandFailure(`could not ${action} ${serial}`, result);
  }
}

async function isDeviceAwake(
  serial: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "dumpsys", "power"],
    { timeout: 5_000, signal, lane: "interactive" },
  );
  if (result.status !== 0) {
    throw commandFailure(`could not read power state for ${serial}`, result);
  }
  return /mWakefulness=Awake\b/.test(result.stdout);
}

export function androidKeycodeToW3c(keycode: number): string | null {
  const named = ANDROID_PRINTABLE_KEYCODE_TO_W3C[keycode];
  if (named) return named;
  if (keycode >= 7 && keycode <= 16) return String(keycode - 7);
  if (keycode >= 29 && keycode <= 54) {
    return String.fromCharCode(97 + keycode - 29);
  }
  return null;
}

/** Translate scrcpy's Android key gesture semantics to emulator key events. */
export function androidKeyGestureToKeyboardEvents(
  gesture: AndroidKeyGesture,
): KeyboardEventRequest[] {
  const eventType: NonNullable<KeyboardEventRequest["eventType"]> =
    gesture.action ?? "press";
  const special = ANDROID_SPECIAL_KEYCODE_TO_W3C[gesture.keycode];
  const evdev = ANDROID_KEYCODE_TO_EVDEV[gesture.keycode];
  const printable = androidKeycodeToW3c(gesture.keycode);
  const key: KeyboardEventRequest | null = special
    ? { key: special, eventType }
    : evdev
      ? { evdev, eventType }
      : printable
        ? { key: printable, eventType }
        : null;
  if (!key) {
    throw new ControlInputRejectedError(
      `Android keycode ${gesture.keycode} is unsupported by grpc-screenshot`,
    );
  }

  const modifiers = modifierKeyRequests(gesture.metaState ?? 0);
  if (modifiers.length === 0) return [key];
  const releaseModifiers = [...modifiers]
    .reverse()
    .map((modifier) => ({ ...modifier, eventType: "up" as const }));
  if (eventType === "down") return [...modifiers, key];
  if (eventType === "up") return [key, ...releaseModifiers];
  return [...modifiers, key, ...releaseModifiers];
}

export function isUsableRgbFrame(image: EmuImage): boolean {
  return (
    image.format === IMG_FORMAT_RGB888 &&
    image.width > 0 &&
    image.height > 0 &&
    Number.isSafeInteger(image.width) &&
    Number.isSafeInteger(image.height) &&
    image.image.length === image.width * image.height * 3
  );
}

export type GrpcDisplayGeometry = {
  encodedSize: { width: number; height: number };
  touchSize: { width: number; height: number };
  mapTouch(unitX: number, unitY: number): { x: number; y: number };
};

export function resolveGrpcDisplayGeometry(options: {
  inputWidth: number;
  inputHeight: number;
  nativeWidth: number;
  nativeHeight: number;
}): GrpcDisplayGeometry {
  const croppedWidth = options.inputWidth - (options.inputWidth % 2);
  const croppedHeight = options.inputHeight - (options.inputHeight % 2);
  const encodedSize = { width: croppedWidth, height: croppedHeight };
  const touchSize = {
    width: options.nativeWidth,
    height: options.nativeHeight,
  };

  const toPixel = (unit: number, size: number) =>
    Math.max(0, Math.min(size - 1, Math.round(unit * size)));

  return {
    encodedSize,
    touchSize,
    mapTouch(unitX, unitY) {
      // Emulator screenshots are already oriented and touch coordinates use
      // that same physical top-left coordinate space.
      return {
        x: toPixel(unitX, touchSize.width),
        y: toPixel(unitY, touchSize.height),
      };
    },
  };
}

export class GrpcFrameWritePacer {
  readonly #frameIntervalMs: number;
  #nextFreshWriteAt = 0;

  constructor(frameIntervalMs: number) {
    if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
      throw new RangeError("frameIntervalMs must be a positive number");
    }
    this.#frameIntervalMs = frameIntervalMs;
  }

  reset(now: number): void {
    this.#nextFreshWriteAt = now;
  }

  recordWrite(now: number, repeat: boolean, accepted = true): void {
    if (repeat || !accepted) return;
    this.#nextFreshWriteAt = Math.max(
      this.#nextFreshWriteAt + this.#frameIntervalMs,
      now + this.#frameIntervalMs,
    );
  }

  waitMs(now: number): number {
    return Math.max(0, this.#nextFreshWriteAt - now);
  }
}

export class GrpcAccessUnitBoundaryCadence {
  readonly #minimumIntervalMs: number;
  #lastFreshImageAt: number | null = null;
  readonly #freshImageIntervals: number[] = [];
  #slowIntervalCandidate: number | null = null;

  constructor(minimumIntervalMs: number) {
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs <= 0) {
      throw new RangeError("minimumIntervalMs must be a positive number");
    }
    this.#minimumIntervalMs = minimumIntervalMs;
  }

  recordFreshImage(now: number): void {
    if (this.#lastFreshImageAt !== null) {
      const interval = now - this.#lastFreshImageAt;
      if (interval > 0) {
        const observedInterval = this.#observedInterval();
        const outlierThreshold = Math.max(
          ACCESS_UNIT_CADENCE_OUTLIER_FLOOR_MS,
          (observedInterval ?? 0) * ACCESS_UNIT_CADENCE_OUTLIER_MULTIPLIER,
        );
        if (interval > outlierThreshold) {
          if (
            observedInterval === null &&
            this.#slowIntervalCandidate !== null &&
            Math.max(interval, this.#slowIntervalCandidate) /
                Math.min(interval, this.#slowIntervalCandidate) <=
              ACCESS_UNIT_SLOW_CADENCE_SIMILARITY
          ) {
            this.#pushInterval(this.#slowIntervalCandidate);
            this.#pushInterval(interval);
            this.#slowIntervalCandidate = null;
          } else if (observedInterval === null) {
            this.#slowIntervalCandidate = interval;
          }
        } else {
          this.#slowIntervalCandidate = null;
          this.#pushInterval(interval);
        }
      }
    }
    this.#lastFreshImageAt = now;
  }

  boundaryDelayMs(): number {
    const observedInterval = this.#observedInterval();
    if (observedInterval === null) {
      return ACCESS_UNIT_BOUNDARY_STARTUP_DELAY_MS;
    }
    return Math.min(
      ACCESS_UNIT_BOUNDARY_MAX_DELAY_MS,
      Math.max(this.#minimumIntervalMs, observedInterval) *
        ACCESS_UNIT_BOUNDARY_IDLE_INTERVALS,
    );
  }

  #pushInterval(interval: number): void {
    this.#freshImageIntervals.push(interval);
    if (this.#freshImageIntervals.length > ACCESS_UNIT_CADENCE_WINDOW) {
      this.#freshImageIntervals.shift();
    }
  }

  #observedInterval(): number | null {
    if (this.#freshImageIntervals.length === 0) return null;
    const sorted = [...this.#freshImageIntervals].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  }
}

type GrpcInputClient = {
  sendTouch(points: TouchPoint[], signal?: AbortSignal): Promise<void>;
  sendKey(event: KeyboardEventRequest, signal?: AbortSignal): Promise<void>;
};

function keyIdentity(event: KeyboardEventRequest): string | null {
  if (event.evdev !== undefined) return `evdev:${event.evdev}`;
  if (event.key) return `key:${event.key}`;
  return null;
}

/** Tracks possibly-sent downs so cancellation can finish with explicit ups. */
export class GrpcInputState {
  readonly #client: GrpcInputClient;
  readonly #activeTouches = new Map<number, TouchPoint>();
  readonly #activeKeys = new Map<string, KeyboardEventRequest>();
  #tail: Promise<void> = Promise.resolve();

  constructor(client: GrpcInputClient) {
    this.#client = client;
  }

  sendTouch(points: TouchPoint[], signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      for (const point of points) {
        if (point.pressure > 0) this.#activeTouches.set(point.identifier, point);
      }
      await this.#client.sendTouch(points, signal);
      for (const point of points) {
        if (point.pressure === 0) this.#activeTouches.delete(point.identifier);
      }
    });
  }

  sendKey(event: KeyboardEventRequest, signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      const identity = keyIdentity(event);
      if (identity && event.eventType === "down") {
        this.#activeKeys.set(identity, event);
      }
      await this.#client.sendKey(event, signal);
      if (identity && event.eventType === "up") {
        this.#activeKeys.delete(identity);
      }
    });
  }

  releaseAll(signal: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      let firstFailure: unknown;
      const touches = [...this.#activeTouches.values()].map((point) => ({
        ...point,
        pressure: 0,
      }));
      if (touches.length > 0) {
        try {
          await this.#client.sendTouch(touches, signal);
          for (const point of touches) {
            this.#activeTouches.delete(point.identifier);
          }
        } catch (error) {
          firstFailure = error;
        }
      }

      for (const [identity, event] of [...this.#activeKeys]) {
        try {
          await this.#client.sendKey(
            { ...event, eventType: "up", text: undefined },
            signal,
          );
          this.#activeKeys.delete(identity);
        } catch (error) {
          firstFailure ??= error;
        }
      }
      if (firstFailure) throw firstFailure;
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/**
 * The emulator translates KeyboardEvent.text through evdev and may silently
 * ignore arbitrary Unicode, so keep this path intentionally ASCII-only:
 * https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/emulator_controller.proto
 *
 * A future Unicode implementation could use the emulator clipboard mechanism:
 * https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/services/emulator-controller/server/src/android/emulation/control/clipboard/Clipboard.cpp
 */
export function normalizeGrpcText(text: string): string {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) {
      throw new ControlInputRejectedError(
        "grpc-screenshot supports ASCII text only",
      );
    }
  }
  return normalizeTextForControl(text);
}

export function normalizeGrpcGestureText(
  gesture: Extract<Gesture, { type: "text" }>,
): string {
  return normalizeGrpcText(gesture.text);
}

export function parseDisplaySizeSignal(output: string): string {
  if (Buffer.byteLength(output) > MAX_DISPLAY_SIZE_OUTPUT_BYTES) {
    throw new Error(
      `display size response exceeds ${MAX_DISPLAY_SIZE_OUTPUT_BYTES} byte limit`,
    );
  }
  const sizes = new Map<string, string>();
  for (const match of output.matchAll(
    /\b(Physical|Override) size:\s*(\d{1,5})x(\d{1,5})\b/g,
  )) {
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (width <= 0 || height <= 0) continue;
    sizes.set(match[1]!.toLowerCase(), `${width}x${height}`);
  }
  if (sizes.size === 0) {
    throw new Error("could not parse emulator display size");
  }
  return ["physical", "override"]
    .flatMap((kind) => {
      const size = sizes.get(kind);
      return size ? [`${kind}:${size}`] : [];
    })
    .join(";");
}

export class GrpcNativeTouchGeometryMonitor {
  readonly #readDisplaySizeSignal: (signal: AbortSignal) => Promise<string>;
  readonly #readNativeImage: (
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number }>;
  readonly #onNativeSize: (size: { width: number; height: number }) => void;
  #displaySizeSignal: string | null;
  #pollTask: Promise<void> | null = null;
  #forcePending = false;
  #forceGeneration = 0;

  constructor(options: {
    initialDisplaySizeSignal: string | null;
    readDisplaySizeSignal: (signal: AbortSignal) => Promise<string>;
    readNativeImage: (
      signal: AbortSignal,
    ) => Promise<{ width: number; height: number }>;
    onNativeSize: (size: { width: number; height: number }) => void;
  }) {
    this.#displaySizeSignal = options.initialDisplaySizeSignal;
    this.#readDisplaySizeSignal = options.readDisplaySizeSignal;
    this.#readNativeImage = options.readNativeImage;
    this.#onNativeSize = options.onNativeSize;
  }

  poll(signal: AbortSignal, force = false): Promise<void> {
    if (force) {
      this.#forcePending = true;
      this.#forceGeneration++;
    }
    if (this.#pollTask) return this.#pollTask;
    const task = this.#drainPolls(signal).finally(() => {
      if (this.#pollTask === task) this.#pollTask = null;
    });
    this.#pollTask = task;
    return task;
  }

  async #drainPolls(signal: AbortSignal): Promise<void> {
    let first = true;
    while (first || this.#forcePending) {
      first = false;
      const force = this.#forcePending;
      this.#forcePending = false;
      const generation = this.#forceGeneration;
      try {
        await this.#pollOnce(signal, force, generation);
      } catch (error) {
        if (!this.#forcePending) throw error;
      }
    }
  }

  async #pollOnce(
    signal: AbortSignal,
    force: boolean,
    generation: number,
  ): Promise<void> {
    throwIfAborted(signal, "display size refresh aborted");
    const nextSignal = await this.#readDisplaySizeSignal(signal);
    if (!force && nextSignal === this.#displaySizeSignal) return;
    const image = await this.#readNativeImage(signal);
    throwIfAborted(signal, "display size refresh aborted");
    if (generation !== this.#forceGeneration) return;
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width <= 0 ||
      image.height <= 0
    ) {
      throw new Error("emulator returned invalid native touch dimensions");
    }
    this.#onNativeSize({ width: image.width, height: image.height });
    this.#displaySizeSignal = nextSignal;
  }
}

export type GrpcSessionDependencies = {
  readDisplaySizeSignal?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<string>;
  runtime?: Partial<GrpcSessionRuntime>;
};

export type GrpcSessionClient = {
  getScreenshot(
    format: ImageFormatRequest,
    signal?: AbortSignal,
  ): Promise<EmuImage>;
  streamScreenshot(
    format: ImageFormatRequest,
    onImage: (image: EmuImage, source: GrpcScreenshotImageSource) => void,
    signal: AbortSignal,
    options?: { maxFps?: number },
  ): Promise<void>;
  sendTouch(points: TouchPoint[], signal?: AbortSignal): Promise<void>;
  sendKey(event: KeyboardEventRequest, signal?: AbortSignal): Promise<void>;
  onSessionError(listener: (error: Error) => void): () => void;
  close(): void;
};

export type GrpcSessionEncoder = {
  readonly width: number;
  readonly height: number;
  readonly quarterTurn: QuarterTurn;
  write(rgb: Buffer, ptsUs: bigint): boolean;
  close(): Promise<void>;
};

export type GrpcSessionRuntime = {
  assertFfmpeg(signal: AbortSignal): Promise<void>;
  ensureEndpoint(serial: string, signal: AbortSignal): Promise<GrpcEndpoint>;
  createClient(endpoint: GrpcEndpoint): GrpcSessionClient;
  createEncoder(options: H264EncoderOpts): GrpcSessionEncoder;
  isDeviceAwake(serial: string, signal: AbortSignal): Promise<boolean>;
  wakeDevice(serial: string, signal: AbortSignal): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export type GrpcEncoderRestart = {
  announceSize: boolean;
  clearPending: boolean;
};

type SessionPacket = Extract<VideoPacket, { type: "session" }>;
type FramePacket = Extract<VideoPacket, { type: "frame" }>;
export type GrpcPacketQueuePushResult = {
  queued: boolean;
  needsKeyFrame: boolean;
};

const PACKET_QUEUED: GrpcPacketQueuePushResult = {
  queued: true,
  needsKeyFrame: false,
};
const PACKET_DROPPED: GrpcPacketQueuePushResult = {
  queued: false,
  needsKeyFrame: false,
};

function queuedPacketBytes(packet: VideoPacket): number {
  return packet.type === "frame" ? packet.data.length : 16;
}

function lastKeyFrameIndex(packets: readonly VideoPacket[]): number {
  for (let index = packets.length - 1; index >= 0; index--) {
    const packet = packets[index]!;
    if (packet.type === "frame" && packet.isKey) return index;
  }
  return -1;
}

function lastSessionPacket(
  packets: readonly VideoPacket[],
  end = packets.length,
): SessionPacket | null {
  for (let index = end - 1; index >= 0; index--) {
    const packet = packets[index]!;
    if (packet.type === "session") return packet;
  }
  return null;
}

/** A byte-bounded queue that only resumes readers from decodable H.264 state. */
export class GrpcVideoPacketQueue {
  readonly #maxBytes: number;
  #packets: VideoPacket[] = [];
  #byteLength = 0;
  #latestConfig: FramePacket | null = null;
  #configByKeyFrame = new WeakMap<FramePacket, FramePacket>();
  #pendingSession: SessionPacket | null = null;
  #awaitingKeyFrame = false;

  constructor(maxBytes = MAX_QUEUED_PACKET_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  push(packet: VideoPacket): GrpcPacketQueuePushResult {
    if (packet.type === "frame" && packet.isConfig) {
      this.#latestConfig = packet;
    }
    if (
      packet.type === "frame" &&
      packet.isKey &&
      this.#latestConfig
    ) {
      this.#configByKeyFrame.set(packet, this.#latestConfig);
    }

    if (this.#awaitingKeyFrame) {
      if (packet.type === "session") {
        this.#pendingSession = packet;
        return PACKET_DROPPED;
      }
      if (packet.isConfig || !packet.isKey) return PACKET_DROPPED;
      return this.#resumeAtKeyFrame(packet);
    }

    this.#packets.push(packet);
    this.#byteLength += queuedPacketBytes(packet);
    if (this.#byteLength <= this.#maxBytes) return PACKET_QUEUED;

    const keyIndex = lastKeyFrameIndex(this.#packets);
    const keyFrame = this.#packets[keyIndex];
    const keyFrameConfig =
      keyFrame?.type === "frame"
        ? this.#configByKeyFrame.get(keyFrame)
        : undefined;
    if (keyIndex < 0 || !keyFrameConfig) {
      return this.#dropUntilKeyFrame();
    }

    const session = lastSessionPacket(this.#packets, keyIndex);
    const suffix = this.#packets.slice(keyIndex);
    const retained = [
      ...(session ? [session] : []),
      keyFrameConfig,
      ...suffix,
    ];
    const retainedBytes = retained.reduce(
      (total, queued) => total + queuedPacketBytes(queued),
      0,
    );
    if (retainedBytes > this.#maxBytes) {
      throw new Error(
        `decodable gRPC H.264 queue exceeds ${this.#maxBytes} byte limit`,
      );
    }
    this.#packets = retained;
    this.#byteLength = retainedBytes;
    return PACKET_QUEUED;
  }

  shift(): VideoPacket | undefined {
    const packet = this.#packets.shift();
    if (packet) this.#byteLength -= queuedPacketBytes(packet);
    return packet;
  }

  clear(): void {
    this.#packets = [];
    this.#byteLength = 0;
    this.#latestConfig = null;
    this.#configByKeyFrame = new WeakMap<FramePacket, FramePacket>();
    this.#pendingSession = null;
    this.#awaitingKeyFrame = false;
  }

  #dropUntilKeyFrame(): GrpcPacketQueuePushResult {
    this.#pendingSession = lastSessionPacket(this.#packets);
    this.#packets = [];
    this.#byteLength = 0;
    this.#awaitingKeyFrame = true;
    return { queued: false, needsKeyFrame: true };
  }

  #resumeAtKeyFrame(keyFrame: FramePacket): GrpcPacketQueuePushResult {
    if (!this.#latestConfig) return PACKET_DROPPED;
    const resumed = [
      ...(this.#pendingSession ? [this.#pendingSession] : []),
      this.#latestConfig,
      keyFrame,
    ];
    const resumedBytes = resumed.reduce(
      (total, queued) => total + queuedPacketBytes(queued),
      0,
    );
    if (resumedBytes > this.#maxBytes) {
      throw new Error(
        `decodable gRPC H.264 queue exceeds ${this.#maxBytes} byte limit`,
      );
    }
    this.#packets = resumed;
    this.#byteLength = resumedBytes;
    this.#pendingSession = null;
    this.#awaitingKeyFrame = false;
    return PACKET_QUEUED;
  }
}

type ClosableEncoder = {
  close(): Promise<void>;
};

/** Serializes encoder replacement and folds a burst into one fresh process. */
export class GrpcEncoderLifecycle<T extends ClosableEncoder> {
  readonly #create: (restart: GrpcEncoderRestart) => T | null | Promise<T | null>;
  #current: T | null = null;
  #pending: GrpcEncoderRestart | null = null;
  #drainTask: Promise<T | null> | null = null;
  #closeTask: Promise<void> | null = null;
  #closed = false;

  constructor(
    create: (restart: GrpcEncoderRestart) => T | null | Promise<T | null>,
  ) {
    this.#create = create;
  }

  get current(): T | null {
    return this.#current;
  }

  restart(restart: GrpcEncoderRestart): Promise<T | null> {
    if (this.#closed) return Promise.resolve(null);
    this.#pending = this.#pending
      ? {
          announceSize: this.#pending.announceSize || restart.announceSize,
          clearPending: this.#pending.clearPending || restart.clearPending,
        }
      : restart;
    if (this.#drainTask) return this.#drainTask;

    const task = this.#drain();
    this.#drainTask = task;
    return task;
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#pending = null;
    this.#closeTask = (async () => {
      await this.#drainTask?.catch(() => {});
      const current = this.#current;
      this.#current = null;
      await current?.close();
    })();
    return this.#closeTask;
  }

  async #drain(): Promise<T | null> {
    let latest = this.#current;
    try {
      while (this.#pending && !this.#closed) {
        const current = this.#current;
        this.#current = null;
        await current?.close();
        if (this.#closed) break;

        // Read after shutdown so requests received while it was in progress are
        // coalesced before another ffmpeg process is spawned.
        const restart = this.#pending;
        this.#pending = null;
        const next = await this.#create(restart);
        if (!next) continue;
        if (this.#closed) {
          await next.close();
          break;
        }
        this.#current = next;
        latest = next;
      }
      return latest;
    } finally {
      // Clear the published task in the same microtask that observes an empty
      // queue. A restart arriving afterward must start a new drain instead of
      // joining a promise whose work has already completed.
      this.#drainTask = null;
    }
  }
}

const defaultReadDisplaySizeSignal: NonNullable<
  GrpcSessionDependencies["readDisplaySizeSignal"]
> = async (serial, signal) => {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "wm", "size"],
    {
      timeout: 5_000,
      maxBuffer: MAX_DISPLAY_SIZE_OUTPUT_BYTES + 1,
      signal,
      lane: "background",
    },
  );
  if (result.status !== 0 || result.error) {
    throw commandFailure("could not read emulator display size", result);
  }
  return parseDisplaySizeSignal(result.stdout);
};

const DEFAULT_GRPC_SESSION_RUNTIME: GrpcSessionRuntime = {
  assertFfmpeg: assertFfmpegAvailable,
  ensureEndpoint: ensureEmulatorGrpcEndpoint,
  createClient: (endpoint) => new EmulatorGrpcClient(endpoint),
  createEncoder: (options) => new H264Encoder(options),
  isDeviceAwake,
  wakeDevice: (serial, signal) => runPowerCommand(serial, "wakeup", signal),
  sleep,
};

function positiveNumber(value: number, name: string, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function nonNegativeInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  nonNegativeNumber(value, name, maximum);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Host-side emulator screenshot capture and input, encoded to the same H.264
 * packet contract as scrcpy.
 */
export async function startGrpcSession(
  options: StartOpts,
  dependencies: GrpcSessionDependencies = {},
): Promise<EmuSession> {
  const serial = options.serial;
  const runtime: GrpcSessionRuntime = {
    ...DEFAULT_GRPC_SESSION_RUNTIME,
    ...dependencies.runtime,
  };
  const readDisplaySizeSignal =
    dependencies.readDisplaySizeSignal ?? defaultReadDisplaySizeSignal;
  const maxFps = positiveNumber(
    options.maxFps ?? SCRCPY_DEFAULTS.maxFps,
    "maxFps",
    1_000,
  );
  const bitRate = nonNegativeInteger(
    options.bitRate ?? SCRCPY_DEFAULTS.bitRate,
    "bitRate",
    0x7fff_ffff,
  );
  if (bitRate === 0) throw new Error("bitRate must be a positive number");
  const maxSize = nonNegativeInteger(
    options.maxSize ?? SCRCPY_DEFAULTS.maxSize,
    "maxSize",
    16_384,
  );
  const keyFrameInterval = nonNegativeNumber(
    options.keyFrameInterval ?? SCRCPY_DEFAULTS.keyFrameInterval,
    "keyFrameInterval",
  );
  const configuredRepeatFrameMs = nonNegativeNumber(
    options.repeatFrameMs ?? SCRCPY_DEFAULTS.repeatFrameMs,
    "repeatFrameMs",
    60_000,
  );
  const repeatFrameMs =
    configuredRepeatFrameMs > 0
      ? configuredRepeatFrameMs
      : DEFAULT_IDLE_REPEAT_MS;
  const frameIntervalMs = 1_000 / maxFps;
  const frameWritePacer = new GrpcFrameWritePacer(frameIntervalMs);
  const accessUnitBoundaryCadence = new GrpcAccessUnitBoundaryCadence(
    frameIntervalMs,
  );

  if (!isEmulatorSerial(serial)) {
    throw new Error(
      `grpc-screenshot requires an Android Emulator serial; received ${serial}`,
    );
  }
  const lifetime = new AbortController();
  const abortFromParent = () =>
    lifetime.abort(
      abortReason(options.signal!, "gRPC screenshot session aborted"),
    );
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted) abortFromParent();

  let endpoint: Awaited<ReturnType<typeof ensureEmulatorGrpcEndpoint>>;
  try {
    await runtime.assertFfmpeg(lifetime.signal);
    endpoint = await runtime.ensureEndpoint(serial, lifetime.signal);
  } catch (error) {
    options.signal?.removeEventListener("abort", abortFromParent);
    throw error;
  }
  const client = runtime.createClient(endpoint);
  const listeners = new Set<(failure: StreamFailure) => void>();
  const packetQueue = new GrpcVideoPacketQueue();
  const waiters: Array<(packet: VideoPacket | null) => void> = [];
  const startupGate = new H264StartupGate();
  let fatalFailure: StreamFailure | null = null;
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let encoderLifecycle: GrpcEncoderLifecycle<GrpcSessionEncoder> | null = null;
  let latest: EmuImage | null = null;
  let lastWriteAt = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let displaySizePollTimer: ReturnType<typeof setTimeout> | null = null;
  let nativeTouchSize = { width: 0, height: 0 };
  let nativeTouchGeometryMonitor: GrpcNativeTouchGeometryMonitor | null = null;
  let sessionMeta: StreamMeta | null = null;
  let resolveFirstImage: ((image: EmuImage) => void) | null = null;
  let rejectFirstImage: ((error: Error) => void) | null = null;
  let requestQueuedKeyFrame: (() => void) | null = null;

  const wakeReaders = () => {
    while (waiters.length) waiters.shift()!(null);
  };
  const getFatalFailure = (): StreamFailure | null => fatalFailure;
  const emitFatal = (failure: StreamFailure) => {
    if (closed || fatalFailure) return;
    fatalFailure = failure;
    const error = new Error(failure.message);
    startupGate.fail(error);
    rejectFirstImage?.(error);
    wakeReaders();
    for (const listener of listeners) listener(failure);
  };
  const pushPacket = (packet: VideoPacket) => {
    if (closed || fatalFailure) return;
    const queued = packetQueue.push(packet);
    if (queued.queued && packet.type === "frame") startupGate.observe(packet);
    if (queued.needsKeyFrame) requestQueuedKeyFrame?.();
    if (waiters.length > 0) {
      const next = packetQueue.shift();
      if (next) waiters.shift()!(next);
    }
  };
  const readFrame = (): Promise<VideoPacket | null> => {
    const packet = packetQueue.shift();
    if (packet) return Promise.resolve(packet);
    if (closed || fatalFailure) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const clearWriteTimers = () => {
    if (writeTimer) clearTimeout(writeTimer);
    if (flushTimer) clearTimeout(flushTimer);
    writeTimer = null;
    flushTimer = null;
  };
  const nowUs = () => BigInt(Math.round(performance.now() * 1_000));
  const writeFrame = (repeat: boolean) => {
    const encoder = encoderLifecycle?.current;
    if (
      closed ||
      lifetime.signal.aborted ||
      fatalFailure ||
      !encoder ||
      !latest
    ) {
      return;
    }
    const now = performance.now();
    const accepted = encoder.write(latest.image, nowUs());
    frameWritePacer.recordWrite(now, repeat, accepted);
    if (accepted) lastWriteAt = Date.now();
    if (repeat) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (!accepted) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          writeFrame(true);
        }, Math.min(ENCODER_WRITE_RETRY_DELAY_MS, frameIntervalMs));
        flushTimer.unref?.();
      }
      return;
    }
    if (!repeat && accepted) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        writeFrame(true);
      }, accessUnitBoundaryCadence.boundaryDelayMs());
      flushTimer.unref?.();
    } else if (!repeat && !writeTimer) {
      writeTimer = setTimeout(() => {
        writeTimer = null;
        scheduleWrite();
      }, Math.min(ENCODER_WRITE_RETRY_DELAY_MS, frameIntervalMs));
      writeTimer.unref?.();
    }
  };
  const scheduleWrite = () => {
    if (writeTimer || closed || !encoderLifecycle?.current || !latest) return;
    const waitMs = frameWritePacer.waitMs(performance.now());
    if (waitMs <= 0) {
      writeFrame(false);
      return;
    }
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeFrame(false);
    }, waitMs);
  };
  const currentGeometry = (image = latest) => {
    if (!image) return null;
    return resolveGrpcDisplayGeometry({
      inputWidth: image.width,
      inputHeight: image.height,
      nativeWidth: nativeTouchSize.width,
      nativeHeight: nativeTouchSize.height,
    });
  };
  encoderLifecycle = new GrpcEncoderLifecycle<GrpcSessionEncoder>((restart) => {
    if (closed || lifetime.signal.aborted || !latest) return null;
    if (restart.clearPending) packetQueue.clear();
    const geometry = currentGeometry(latest)!;
    const size = geometry.encodedSize;
    if (size.width <= 0 || size.height <= 0) {
      emitFatal({ message: "emulator returned an image too small to encode" });
      return null;
    }
    frameWritePacer.reset(performance.now());
    if (sessionMeta) {
      sessionMeta.width = size.width;
      sessionMeta.height = size.height;
    }
    const next = runtime.createEncoder({
      width: latest.width,
      height: latest.height,
      quarterTurn: 0,
      fps: maxFps,
      bitRate,
      keyFrameInterval,
      onFrame: (frame: VideoFrame) => pushPacket(frame),
      onExit: (message) => emitFatal({ message, code: "encoder-exit" }),
    });
    if (restart.announceSize) {
      pushPacket({
        type: "session",
        width: size.width,
        height: size.height,
        clientResized: false,
      });
    }
    return next;
  });
  const restartEncoder = (
    announceSize: boolean,
    clearPending: boolean,
  ): Promise<void> => {
    if (closed || lifetime.signal.aborted || !latest) return Promise.resolve();
    clearWriteTimers();
    return encoderLifecycle!
      .restart({ announceSize, clearPending })
      .then((started) => {
        if (started && encoderLifecycle?.current === started) writeFrame(false);
      });
  };
  requestQueuedKeyFrame = () => {
    void restartEncoder(false, false).catch((error) =>
      emitFatal({
        message: `could not recover the H.264 packet queue: ${error instanceof Error ? error.message : String(error)}`,
        code: "encoder-exit",
      })
    );
  };

  const refreshNativeTouchGeometry = (force = false): Promise<void> => {
    if (!nativeTouchGeometryMonitor || closed || lifetime.signal.aborted) {
      return Promise.resolve();
    }
    return nativeTouchGeometryMonitor.poll(lifetime.signal, force).catch((error) => {
      if (!closed && !lifetime.signal.aborted) {
        console.warn(
          `serve-emu could not refresh native touch geometry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  const scheduleDisplaySizePoll = () => {
    if (
      closed ||
      lifetime.signal.aborted ||
      displaySizePollTimer ||
      !nativeTouchGeometryMonitor
    ) {
      return;
    }
    displaySizePollTimer = setTimeout(() => {
      displaySizePollTimer = null;
      void refreshNativeTouchGeometry().finally(scheduleDisplaySizePoll);
    }, DISPLAY_SIZE_POLL_MS);
    displaySizePollTimer.unref?.();
  };

  const onImage = (
    image: EmuImage,
    source: GrpcScreenshotImageSource = "stream",
  ) => {
    if (closed || !isUsableRgbFrame(image)) return;
    if (source === "stream") {
      accessUnitBoundaryCadence.recordFreshImage(performance.now());
    }
    const encoder = encoderLifecycle?.current;
    const geometryChanged =
      encoder !== null &&
      encoder !== undefined &&
      (image.width !== encoder.width ||
        image.height !== encoder.height);
    const imageIsLandscape = image.width > image.height;
    const nativeIsLandscape = nativeTouchSize.width > nativeTouchSize.height;
    if (imageIsLandscape !== nativeIsLandscape) {
      nativeTouchSize = {
        width: nativeTouchSize.height,
        height: nativeTouchSize.width,
      };
    }
    latest = image;
    if (resolveFirstImage) {
      const resolve = resolveFirstImage;
      resolveFirstImage = null;
      resolve(image);
      return;
    }
    if (geometryChanged) {
      void refreshNativeTouchGeometry(true);
      void restartEncoder(true, true).catch((error) =>
        emitFatal({
          message: `could not restart H.264 encoder: ${error instanceof Error ? error.message : String(error)}`,
          code: "encoder-exit",
        })
      );
      return;
    }
    scheduleWrite();
  };

  const inputState = new GrpcInputState(client);
  const touch = async (
    unitX: number,
    unitY: number,
    pressure: number,
    identifier: number,
    signal: AbortSignal,
  ) => {
    const geometry = currentGeometry();
    if (!geometry) {
      throw new ControlInputRejectedError(
        "gRPC touch input is unavailable before the first video frame",
      );
    }
    if (identifier > 0x7fffffff) {
      throw new ControlInputRejectedError(
        "gRPC touch pointerId must fit in a signed 32-bit integer",
      );
    }
    const point = geometry.mapTouch(unitX, unitY);
    await inputState.sendTouch(
      [
        {
          x: point.x,
          y: point.y,
          identifier,
          pressure,
        },
      ],
      signal,
    );
  };
  const tapTouch = async (
    x: number,
    y: number,
    signal: AbortSignal,
  ) => {
    await touch(x, y, TOUCH_PRESSURE, 0, signal);
    await runtime.sleep(20, signal);
    await touch(x, y, 0, 0, signal);
  };
  const swipeTouch = async (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    signal: AbortSignal,
  ) => {
    const duration = Math.max(80, durationMs);
    const steps = Math.max(8, Math.round(duration / 16));
    await touch(x1, y1, TOUCH_PRESSURE, 0, signal);
    for (let index = 1; index < steps; index++) {
      const progress = index / steps;
      await runtime.sleep(duration / steps, signal);
      await touch(
        x1 + (x2 - x1) * progress,
        y1 + (y2 - y1) * progress,
        TOUCH_PRESSURE,
        0,
        signal,
      );
    }
    await runtime.sleep(duration / steps, signal);
    await touch(x2, y2, 0, 0, signal);
  };

  const dispatchGesture = async (
    gesture: Gesture,
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal, "gRPC input aborted");
    switch (gesture.type) {
      case "tap":
        return tapTouch(gesture.x, gesture.y, signal);
      case "swipe":
        return swipeTouch(
          gesture.x1,
          gesture.y1,
          gesture.x2,
          gesture.y2,
          gesture.durationMs ?? 250,
          signal,
        );
      case "touch":
        return touch(
          gesture.x,
          gesture.y,
          gesture.action === "up" ? 0 : TOUCH_PRESSURE,
          gesture.pointerId ?? 0,
          signal,
        );
      case "key": {
        for (const event of androidKeyGestureToKeyboardEvents(gesture)) {
          await inputState.sendKey(event, signal);
        }
        return;
      }
      case "text":
        return inputState.sendKey(
          { text: normalizeGrpcGestureText(gesture) },
          signal,
        );
      case "back":
        return inputState.sendKey({ key: "GoBack" }, signal);
      case "home":
        return inputState.sendKey({ key: "GoHome" }, signal);
      case "recents":
        return inputState.sendKey({ key: "AppSwitch" }, signal);
      case "power":
        return inputState.sendKey({ key: "Power" }, signal);
    }
  };

  let inputReleaseTask: Promise<void> | null = null;
  const releaseInput = (): Promise<void> => {
    if (inputReleaseTask) return inputReleaseTask;
    const cleanup = new AbortController();
    const timer = setTimeout(
      () => cleanup.abort(new Error("gRPC input release timed out")),
      INPUT_RELEASE_TIMEOUT_MS,
    );
    timer.unref?.();
    let task!: Promise<void>;
    task = inputState
      .releaseAll(cleanup.signal)
      .catch((error) => {
        console.warn(
          `serve-emu could not release gRPC input state: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (inputReleaseTask === task) inputReleaseTask = null;
      });
    inputReleaseTask = task;
    return task;
  };

  const controls = new ControlInputQueue({
    dispatcher: {
      dispatchGesture: (gesture, _screen, signal) =>
        dispatchGesture(gesture, signal),
      async resetVideo(signal) {
        throwIfAborted(signal, "gRPC video reset aborted");
        // Existing packets remain valid until the replacement emits its IDR.
        // The lifecycle coalesces bursts and never overlaps ffmpeg shutdowns.
        await restartEncoder(false, false);
        throwIfAborted(signal, "gRPC video reset aborted");
      },
      close() {
        void releaseInput();
      },
    },
  });

  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    let finishClose!: () => void;
    closeTask = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    closed = true;
    options.signal?.removeEventListener("abort", abortFromParent);
    lifetime.abort(new Error("gRPC screenshot session closed"));
    clearWriteTimers();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    if (displaySizePollTimer) clearTimeout(displaySizePollTimer);
    displaySizePollTimer = null;
    controls.close(new Error("gRPC screenshot session closed"));
    const inputRelease = releaseInput();
    const encoderClose = encoderLifecycle?.close() ?? Promise.resolve();
    listeners.clear();
    packetQueue.clear();
    wakeReaders();
    void Promise.allSettled([inputRelease, encoderClose]).then(() => {
      client.close();
      finishClose();
    });
    return closeTask;
  };
  const onParentAbort = () => {
    void close();
  };
  lifetime.signal.addEventListener("abort", onParentAbort, { once: true });
  const unsubscribeClientError = client.onSessionError((error) =>
    emitFatal({
      message: `emulator gRPC connection error: ${error.message}`,
      code: "grpc-connection-error",
    }),
  );

  try {
    throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
    const [initialDisplaySizeSignal] = await Promise.all([
      readDisplaySizeSignal(serial, lifetime.signal).catch((error) => {
        throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
        console.warn(
          `serve-emu could not read the initial display size: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }),
    ]);
    throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
    if (!(await runtime.isDeviceAwake(serial, lifetime.signal))) {
      await runtime.wakeDevice(serial, lifetime.signal);
      await runtime.sleep(100, lifetime.signal);
    }
    let probe = await client.getScreenshot(
      { format: IMG_FORMAT_PNG },
      lifetime.signal,
    );
    if (probe.width <= 0 || probe.height <= 0) {
      await runtime.wakeDevice(serial, lifetime.signal);
      for (
        let attempt = 0;
        attempt < 20 && (probe.width <= 0 || probe.height <= 0);
        attempt++
      ) {
        await runtime.sleep(100, lifetime.signal);
        probe = await client.getScreenshot(
          { format: IMG_FORMAT_PNG },
          lifetime.signal,
        );
      }
      if (probe.width <= 0 || probe.height <= 0) {
        throw new Error(
          "emulator display stayed inactive after requesting wakeup",
        );
      }
    }
    nativeTouchSize = {
      width: probe.width,
      height: probe.height,
    };
    nativeTouchGeometryMonitor = new GrpcNativeTouchGeometryMonitor({
      initialDisplaySizeSignal,
      readDisplaySizeSignal: (signal) =>
        readDisplaySizeSignal(serial, signal),
      readNativeImage: (signal) =>
        client.getScreenshot({ format: IMG_FORMAT_PNG }, signal),
      onNativeSize: (size) => {
        nativeTouchSize = size;
      },
    });
    const existingFailure = getFatalFailure();
    if (existingFailure) throw new Error(existingFailure.message);

    let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let firstFrameAbort: (() => void) | null = null;
    const firstImage = new Promise<EmuImage>((resolve, reject) => {
      const finish = (image?: EmuImage, error?: Error) => {
        if (firstFrameTimer) clearTimeout(firstFrameTimer);
        if (firstFrameAbort) {
          lifetime.signal.removeEventListener("abort", firstFrameAbort);
        }
        resolveFirstImage = null;
        rejectFirstImage = null;
        if (error) reject(error);
        else resolve(image!);
      };
      resolveFirstImage = (image) => finish(image);
      rejectFirstImage = (error) => finish(undefined, error);
      firstFrameAbort = () =>
        finish(
          undefined,
          abortReason(lifetime.signal, "first emulator frame aborted"),
        );
      lifetime.signal.addEventListener("abort", firstFrameAbort, { once: true });
      firstFrameTimer = setTimeout(
        () =>
          finish(
            undefined,
            new Error("timed out waiting for the first emulator frame"),
          ),
        FIRST_FRAME_TIMEOUT_MS,
      );
      firstFrameTimer.unref?.();
    });
    void client
      .streamScreenshot(
        {
          format: IMG_FORMAT_RGB888,
          width: maxSize,
          height: maxSize,
        },
        onImage,
        lifetime.signal,
        { maxFps },
      )
      .then(
        () => {
          if (!lifetime.signal.aborted) {
            emitFatal({
              message: "emulator screenshot stream ended",
              code: "grpc-stream-ended",
            });
          }
        },
        (error) => {
          if (!lifetime.signal.aborted) {
            emitFatal({
              message: `emulator screenshot stream failed: ${error instanceof Error ? error.message : String(error)}`,
              code: "grpc-stream-error",
            });
          }
        },
      );
    const first = await firstImage;
    latest = first;
    await restartEncoder(false, false);
    await startupGate.wait(lifetime.signal, FIRST_FRAME_TIMEOUT_MS);
    idleTimer = setInterval(() => {
      if (
        !closed &&
        encoderLifecycle?.current &&
        Date.now() - lastWriteAt >= repeatFrameMs
      ) {
        writeFrame(true);
      }
    }, Math.max(16, Math.min(250, repeatFrameMs / 2)));
    scheduleDisplaySizePoll();

    const size = currentGeometry(first)!.encodedSize;
    const meta: StreamMeta = {
      deviceName: endpoint.avdName ?? serial,
      codecId: "h264",
      width: size.width,
      height: size.height,
    };
    sessionMeta = meta;
    return {
      mode: "grpc-screenshot",
      serial,
      meta,
      controls,
      readFrame,
      onFatal(listener) {
        listeners.add(listener);
        if (fatalFailure) listener(fatalFailure);
        return () => listeners.delete(listener);
      },
      async close() {
        unsubscribeClientError();
        lifetime.signal.removeEventListener("abort", onParentAbort);
        await close();
      },
    };
  } catch (error) {
    unsubscribeClientError();
    lifetime.signal.removeEventListener("abort", onParentAbort);
    await close();
    throw error;
  }
}
