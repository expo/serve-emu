import { setTimeout as delay } from "node:timers/promises";
import {
  ControlInputQueue,
  ControlInputRejectedError,
} from "./control-input-queue.ts";
import {
  EmulatorGrpcClient,
  ensureEmulatorGrpcEndpoint,
  IMG_FORMAT_PNG,
  IMG_FORMAT_RGB888,
  type EmuImage,
  type KeyboardEventRequest,
  type TouchPoint,
} from "./emulator-grpc.ts";
import {
  getDisplayRotation,
  type DisplayRotation,
} from "./adb.ts";
import { execText, type ExecResult } from "./exec.ts";
import {
  H264Encoder,
  assertFfmpegAvailable,
  type QuarterTurn,
} from "./h264-encoder.ts";
import {
  normalizeTextForControl,
  originalTextForControl,
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

const FLUSH_MS = 40;
const DEFAULT_IDLE_REPEAT_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_QUEUED_PACKETS = 256;
const DISPLAY_ROTATION_POLL_MS = 500;
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

async function readNavigationMode(
  serial: string,
  signal: AbortSignal,
): Promise<0 | 1 | 2 | null> {
  const result = await execText(
    "adb",
    ["-s", serial, "shell", "settings", "get", "secure", "navigation_mode"],
    { timeout: 5_000, signal, lane: "interactive" },
  );
  const mode = Number(result.stdout.trim());
  return result.status === 0 && (mode === 0 || mode === 1 || mode === 2)
    ? mode
    : null;
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

async function toggleDevicePower(
  serial: string,
  signal: AbortSignal,
): Promise<void> {
  await runPowerCommand(
    serial,
    (await isDeviceAwake(serial, signal)) ? "sleep" : "wakeup",
    signal,
  );
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

function annexBNalTypes(data: Buffer): Set<number> {
  const types = new Set<number>();
  for (let offset = 0; offset + 3 < data.length; offset++) {
    if (data[offset] !== 0 || data[offset + 1] !== 0) continue;
    const header = data[offset + 2] === 1
      ? offset + 3
      : data[offset + 2] === 0 && data[offset + 3] === 1
        ? offset + 4
        : -1;
    if (header >= 0 && header < data.length) {
      types.add(data[header]! & 0x1f);
      offset = header;
    }
  }
  return types;
}

/** Startup latch that proves a new browser can decode the encoder output. */
export class H264StartupGate {
  readonly #promise: Promise<void>;
  #resolve!: () => void;
  #reject!: (error: Error) => void;
  #settled = false;
  #sawSps = false;
  #sawPps = false;
  #sawKeyFrame = false;

  constructor() {
    this.#promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A transport can fail before startGrpcSession reaches its await point.
    void this.#promise.catch(() => {});
  }

  observe(frame: VideoFrame): void {
    if (this.#settled) return;
    if (frame.isConfig) {
      const types = annexBNalTypes(frame.data);
      this.#sawSps ||= types.has(7);
      this.#sawPps ||= types.has(8);
    }
    this.#sawKeyFrame ||= frame.isKey;
    if (this.#sawSps && this.#sawPps && this.#sawKeyFrame) {
      this.#settled = true;
      this.#resolve();
    }
  }

  fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }

  wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) {
      this.fail(abortReason(signal, "H.264 startup aborted"));
    }
    const onAbort = () =>
      this.fail(abortReason(signal, "H.264 startup aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      this.fail(
        new Error(
          `timed out waiting for decodable H.264 output after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    return this.#promise.finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  }
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
  quarterTurn: QuarterTurn;
  encodedSize: { width: number; height: number };
  touchSize: { width: number; height: number };
  mapTouch(unitX: number, unitY: number): { x: number; y: number };
};

export function resolveGrpcDisplayGeometry(options: {
  inputWidth: number;
  inputHeight: number;
  nativeWidth: number;
  nativeHeight: number;
  quarterTurn: QuarterTurn;
}): GrpcDisplayGeometry {
  const croppedWidth = options.inputWidth - (options.inputWidth % 2);
  const croppedHeight = options.inputHeight - (options.inputHeight % 2);
  const transposed = options.quarterTurn === 1 || options.quarterTurn === 3;
  const encodedSize = transposed
    ? { width: croppedHeight, height: croppedWidth }
    : { width: croppedWidth, height: croppedHeight };
  const touchSize = {
    width: options.nativeWidth,
    height: options.nativeHeight,
  };

  const toPixel = (unit: number, size: number) =>
    Math.max(0, Math.min(size - 1, Math.round(unit * size)));

  return {
    quarterTurn: options.quarterTurn,
    encodedSize,
    touchSize,
    mapTouch(unitX, unitY) {
      // sendTouch consumes coordinates in the emulator's unrotated physical
      // surface. Map the point back through the inverse of ffmpeg's display
      // transform so a click follows the pixels the browser presents.
      if (options.quarterTurn === 1) {
        return {
          x: toPixel(1 - unitY, touchSize.width),
          y: toPixel(unitX, touchSize.height),
        };
      }
      if (options.quarterTurn === 2) {
        return {
          x: toPixel(1 - unitX, touchSize.width),
          y: toPixel(1 - unitY, touchSize.height),
        };
      }
      if (options.quarterTurn === 3) {
        return {
          x: toPixel(unitY, touchSize.width),
          y: toPixel(1 - unitX, touchSize.height),
        };
      }
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
  return normalizeGrpcText(originalTextForControl(gesture));
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

  poll(signal: AbortSignal): Promise<void> {
    if (this.#pollTask) return this.#pollTask;
    const task = this.#pollOnce(signal).finally(() => {
      if (this.#pollTask === task) this.#pollTask = null;
    });
    this.#pollTask = task;
    return task;
  }

  async #pollOnce(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal, "display size refresh aborted");
    const nextSignal = await this.#readDisplaySizeSignal(signal);
    if (nextSignal === this.#displaySizeSignal) return;
    const image = await this.#readNativeImage(signal);
    throwIfAborted(signal, "display size refresh aborted");
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
  readDisplayRotation?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<DisplayRotation>;
  readDisplaySizeSignal?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<string>;
};

const defaultReadDisplayRotation: NonNullable<
  GrpcSessionDependencies["readDisplayRotation"]
> = (serial, signal) => getDisplayRotation(serial, execText, signal);

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

export async function readInitialDisplayRotation(
  readRotation: () => Promise<DisplayRotation>,
  signal: AbortSignal,
  reportWarning: (message: string) => void = console.warn,
): Promise<DisplayRotation | null> {
  try {
    return await readRotation();
  } catch (error) {
    throwIfAborted(signal, "gRPC screenshot startup aborted");
    reportWarning(
      `serve-emu could not read the initial display rotation; starting with the emulator screenshot rotation and polling for recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function rotationFromEmulatorImage(rotation: number): DisplayRotation {
  const quarterTurns = rotation > 3 ? rotation / 90 : rotation;
  return Number.isInteger(quarterTurns) && quarterTurns >= 0 && quarterTurns <= 3
    ? (quarterTurns as DisplayRotation)
    : 0;
}

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
  const readDisplayRotation =
    dependencies.readDisplayRotation ?? defaultReadDisplayRotation;
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

  if (!/^emulator-\d+$/.test(serial)) {
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
    await assertFfmpegAvailable(lifetime.signal);
    endpoint = await ensureEmulatorGrpcEndpoint(serial, lifetime.signal);
  } catch (error) {
    options.signal?.removeEventListener("abort", abortFromParent);
    throw error;
  }
  const client = new EmulatorGrpcClient(endpoint);
  const listeners = new Set<(failure: StreamFailure) => void>();
  const packetQueue: VideoPacket[] = [];
  const waiters: Array<(packet: VideoPacket | null) => void> = [];
  const startupGate = new H264StartupGate();
  let fatalFailure: StreamFailure | null = null;
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let encoder: H264Encoder | null = null;
  let latest: EmuImage | null = null;
  let lastWriteAt = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let rotationPollTimer: ReturnType<typeof setTimeout> | null = null;
  let displaySizePollTimer: ReturnType<typeof setTimeout> | null = null;
  let displayRotation: DisplayRotation = 0;
  let nativePortrait = { width: 0, height: 0 };
  let nativeTouchGeometryMonitor: GrpcNativeTouchGeometryMonitor | null = null;
  let sessionMeta: StreamMeta | null = null;
  let resolveFirstImage: ((image: EmuImage) => void) | null = null;
  let rejectFirstImage: ((error: Error) => void) | null = null;

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
    if (packet.type === "frame") startupGate.observe(packet);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(packet);
      return;
    }
    packetQueue.push(packet);
    if (packetQueue.length > MAX_QUEUED_PACKETS) {
      packetQueue.splice(0, packetQueue.length - MAX_QUEUED_PACKETS);
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
    if (repeat && flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!repeat && accepted) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        writeFrame(true);
      }, FLUSH_MS);
    } else if (!repeat && !writeTimer) {
      writeTimer = setTimeout(() => {
        writeTimer = null;
        scheduleWrite();
      }, Math.min(FLUSH_MS, frameIntervalMs));
      writeTimer.unref?.();
    }
  };
  const scheduleWrite = () => {
    if (writeTimer || closed || !encoder || !latest) return;
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
      nativeWidth: nativePortrait.width,
      nativeHeight: nativePortrait.height,
      quarterTurn: displayRotation,
    });
  };
  const startEncoder = (announceSize: boolean, clearPending: boolean) => {
    if (closed || lifetime.signal.aborted || !latest) return;
    clearWriteTimers();
    void encoder?.close();
    if (clearPending) packetQueue.length = 0;
    const geometry = currentGeometry(latest)!;
    const size = geometry.encodedSize;
    if (size.width <= 0 || size.height <= 0) {
      emitFatal({ message: "emulator returned an image too small to encode" });
      return;
    }
    frameWritePacer.reset(performance.now());
    if (sessionMeta) {
      sessionMeta.width = size.width;
      sessionMeta.height = size.height;
    }
    encoder = new H264Encoder({
      width: latest.width,
      height: latest.height,
      quarterTurn: geometry.quarterTurn,
      fps: maxFps,
      bitRate,
      keyFrameInterval,
      onFrame: (frame: VideoFrame) => pushPacket(frame),
      onExit: (message) => emitFatal({ message, code: "encoder-exit" }),
    });
    if (announceSize) {
      pushPacket({
        type: "session",
        width: size.width,
        height: size.height,
        clientResized: false,
      });
    }
    writeFrame(false);
  };

  const scheduleRotationPoll = () => {
    if (closed || lifetime.signal.aborted || rotationPollTimer) return;
    rotationPollTimer = setTimeout(() => {
      rotationPollTimer = null;
      void (async () => {
        try {
          const nextRotation = await readDisplayRotation(
            serial,
            lifetime.signal,
          );
          if (closed || lifetime.signal.aborted) return;
          if (nextRotation !== displayRotation) {
            displayRotation = nextRotation;
            startEncoder(true, true);
          }
        } catch (error) {
          if (!closed && !lifetime.signal.aborted) {
            console.warn(
              `serve-emu could not refresh display rotation: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } finally {
          scheduleRotationPoll();
        }
      })();
    }, DISPLAY_ROTATION_POLL_MS);
    rotationPollTimer.unref?.();
  };

  const refreshNativeTouchGeometry = (): Promise<void> => {
    if (!nativeTouchGeometryMonitor || closed || lifetime.signal.aborted) {
      return Promise.resolve();
    }
    return nativeTouchGeometryMonitor.poll(lifetime.signal).catch((error) => {
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

  const onImage = (image: EmuImage) => {
    if (closed || !isUsableRgbFrame(image)) return;
    latest = image;
    if (resolveFirstImage) {
      const resolve = resolveFirstImage;
      resolveFirstImage = null;
      resolve(image);
      return;
    }
    if (
      encoder &&
      (image.width !== encoder.width || image.height !== encoder.height)
    ) {
      void refreshNativeTouchGeometry();
      startEncoder(true, true);
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
    await sleep(20, signal);
    await touch(x, y, 0, 0, signal);
  };
  const swipeTouch = async (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
    holdMs: number,
    signal: AbortSignal,
  ) => {
    const duration = Math.max(80, durationMs);
    const steps = Math.max(8, Math.round(duration / 16));
    await touch(x1, y1, TOUCH_PRESSURE, 0, signal);
    for (let index = 1; index < steps; index++) {
      const progress = index / steps;
      await sleep(duration / steps, signal);
      await touch(
        x1 + (x2 - x1) * progress,
        y1 + (y2 - y1) * progress,
        TOUCH_PRESSURE,
        0,
        signal,
      );
    }
    await sleep(duration / steps + holdMs, signal);
    await touch(x2, y2, 0, 0, signal);
  };

  let navigationMode: 0 | 1 | 2 | null = null;
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
          0,
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
        return navigationMode === 2
          ? swipeTouch(0.002, 0.5, 0.28, 0.5, 180, 0, signal)
          : navigationMode === 0 || navigationMode === 1
            ? tapTouch(0.17, 0.985, signal)
            : inputState.sendKey({ key: "GoBack" }, signal);
      case "home":
        return navigationMode === 2
          ? swipeTouch(0.5, 0.995, 0.5, 0.65, 250, 0, signal)
          : navigationMode === 0 || navigationMode === 1
            ? tapTouch(0.5, 0.985, signal)
            : inputState.sendKey({ key: "GoHome" }, signal);
      case "recents":
        return navigationMode === 0
          ? tapTouch(0.83, 0.985, signal)
          : navigationMode === 1 || navigationMode === 2
            ? swipeTouch(0.5, 0.995, 0.5, 0.55, 280, 500, signal)
            : inputState.sendKey({ key: "AppSwitch" }, signal);
      case "power":
        return toggleDevicePower(serial, signal);
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
        startEncoder(false, true);
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
    if (rotationPollTimer) clearTimeout(rotationPollTimer);
    rotationPollTimer = null;
    if (displaySizePollTimer) clearTimeout(displaySizePollTimer);
    displaySizePollTimer = null;
    controls.close(new Error("gRPC screenshot session closed"));
    const inputRelease = releaseInput();
    const encoderClose = encoder?.close() ?? Promise.resolve();
    encoder = null;
    listeners.clear();
    packetQueue.length = 0;
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
    const [
      initialNavigationMode,
      initialDisplayRotation,
      initialDisplaySizeSignal,
    ] = await Promise.all([
      readNavigationMode(serial, lifetime.signal),
      readInitialDisplayRotation(
        () => readDisplayRotation(serial, lifetime.signal),
        lifetime.signal,
      ),
      readDisplaySizeSignal(serial, lifetime.signal).catch((error) => {
        throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
        console.warn(
          `serve-emu could not read the initial display size: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }),
    ]);
    navigationMode = initialNavigationMode;
    throwIfAborted(lifetime.signal, "gRPC screenshot startup aborted");
    if (!(await isDeviceAwake(serial, lifetime.signal))) {
      await runPowerCommand(serial, "wakeup", lifetime.signal);
      await sleep(100, lifetime.signal);
    }
    let probe = await client.getScreenshot(
      { format: IMG_FORMAT_PNG },
      lifetime.signal,
    );
    if (probe.width <= 0 || probe.height <= 0) {
      await runPowerCommand(serial, "wakeup", lifetime.signal);
      for (
        let attempt = 0;
        attempt < 20 && (probe.width <= 0 || probe.height <= 0);
        attempt++
      ) {
        await sleep(100, lifetime.signal);
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
    displayRotation =
      initialDisplayRotation ?? rotationFromEmulatorImage(probe.rotation);
    nativePortrait = {
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
        nativePortrait = size;
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
    startEncoder(false, false);
    await startupGate.wait(lifetime.signal, FIRST_FRAME_TIMEOUT_MS);
    idleTimer = setInterval(() => {
      if (
        !closed &&
        encoder &&
        Date.now() - lastWriteAt >= repeatFrameMs
      ) {
        writeFrame(true);
      }
    }, Math.max(16, Math.min(250, repeatFrameMs / 2)));
    scheduleRotationPoll();
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
