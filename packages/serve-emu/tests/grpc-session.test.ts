import { describe, expect, test } from "bun:test";
import {
  GrpcFrameWritePacer,
  GrpcCaptureDiagnosticsTracker,
  GrpcInputState,
  GrpcMmapNotificationScheduler,
  GrpcNativeTouchGeometryMonitor,
  H264StartupGate,
  androidKeyGestureToKeyboardEvents,
  androidKeycodeToW3c,
  grpcPredecodeMaxFps,
  isUsablePngFrame,
  isUsableRgbFrame,
  normalizeGrpcGestureText,
  normalizeGrpcText,
  nativeTouchSizeFromEmulatorImage,
  parseDisplaySizeSignal,
  readMmapImageNotification,
  readInitialDisplayRotation,
  resolveGrpcDisplayGeometry,
  type GrpcMmapNotificationSchedulerClock,
} from "../src/grpc-session.ts";
import {
  IMG_FORMAT_PNG,
  IMG_FORMAT_RGB888,
  type EmuImage,
} from "../src/emulator-grpc.ts";
import { compileGesture, parseGesture } from "../src/input.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

const CONFIG_FRAME: VideoFrame = {
  type: "frame",
  data: Buffer.from([0, 0, 0, 1, 0x67, 0x01, 0, 0, 0, 1, 0x68, 0x01]),
  pts: 0n,
  isConfig: true,
  isKey: false,
};

const SPS_FRAME: VideoFrame = {
  ...CONFIG_FRAME,
  data: Buffer.from([0, 0, 0, 1, 0x67, 0x01]),
};

const PPS_FRAME: VideoFrame = {
  ...CONFIG_FRAME,
  data: Buffer.from([0, 0, 0, 1, 0x68, 0x01]),
};

const KEY_FRAME: VideoFrame = {
  type: "frame",
  data: Buffer.from([0, 0, 0, 1, 0x65]),
  pts: 1n,
  isConfig: false,
  isKey: true,
};

class FakeMmapSchedulerClock implements GrpcMmapNotificationSchedulerClock {
  nowMs = 0;
  #nextTimer = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  readonly #microtasks: Array<() => void> = [];

  now(): number {
    return this.nowMs;
  }

  queueMicrotask(callback: () => void): void {
    this.#microtasks.push(callback);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextTimer++;
    this.#timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  flushMicrotasks(): void {
    while (this.#microtasks.length > 0) this.#microtasks.shift()!();
  }

  advance(delayMs: number): void {
    const target = this.nowMs + delayMs;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(
          (left, right) => left[1].at - right[1].at || left[0] - right[0],
        )[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].callback();
    }
    this.nowMs = target;
  }
}

function mmapNotification(seq: number, timestampUs: bigint): EmuImage {
  return {
    width: 1,
    height: 1,
    format: IMG_FORMAT_RGB888,
    rotation: 0,
    image: Buffer.alloc(0),
    seq,
    timestampUs,
  };
}

describe("gRPC screenshot session helpers", () => {
  test("maps printable Android keycodes", () => {
    expect(androidKeycodeToW3c(7)).toBe("0");
    expect(androidKeycodeToW3c(29)).toBe("a");
    expect(androidKeycodeToW3c(54)).toBe("z");
    expect(androidKeycodeToW3c(62)).toBe(" ");
    expect(androidKeycodeToW3c(999)).toBeNull();
  });

  test("preserves down/up actions for mapped and special Android keys", () => {
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 66,
        action: "down",
      }),
    ).toEqual([{ evdev: 28, eventType: "down" }]);
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 66,
        action: "up",
      }),
    ).toEqual([{ evdev: 28, eventType: "up" }]);
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 3,
        action: "down",
      }),
    ).toEqual([{ key: "GoHome", eventType: "down" }]);
    expect(
      androidKeyGestureToKeyboardEvents({ type: "key", keycode: 187 }),
    ).toEqual([{ key: "AppSwitch", eventType: "press" }]);
  });

  test("wraps supported Android metaState modifiers around keypresses", () => {
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 29,
        metaState: 0x1000,
      }),
    ).toEqual([
      { evdev: 29, eventType: "down" },
      { key: "a", eventType: "press" },
      { evdev: 29, eventType: "up" },
    ]);
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 29,
        action: "down",
        metaState: 0x1000,
      }),
    ).toEqual([
      { evdev: 29, eventType: "down" },
      { key: "a", eventType: "down" },
    ]);
    expect(
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 29,
        action: "up",
        metaState: 0x1000,
      }),
    ).toEqual([
      { key: "a", eventType: "up" },
      { evdev: 29, eventType: "up" },
    ]);
  });

  test("rejects Android metaState bits that gRPC cannot encode", () => {
    expect(() =>
      androidKeyGestureToKeyboardEvents({
        type: "key",
        keycode: 29,
        metaState: 0x0010_0000,
      }),
    ).toThrow("cannot encode Android key metaState bits 0x100000");
  });

  test("accepts only complete RGB888 frames", () => {
    const base = {
      width: 2,
      height: 3,
      format: IMG_FORMAT_RGB888,
      rotation: 0,
      seq: 1,
      timestampUs: 1n,
    };
    expect(isUsableRgbFrame({ ...base, image: Buffer.alloc(2 * 3 * 3) })).toBe(
      true,
    );
    expect(
      isUsableRgbFrame({ ...base, image: Buffer.alloc(2 * 3 * 3 - 1) }),
    ).toBe(false);
    expect(
      isUsableRgbFrame({ ...base, format: 0, image: Buffer.alloc(18) }),
    ).toBe(false);
  });

  test("accepts in-band PNG frames and bypasses predecode pacing only for MMAP", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const base = {
      width: 2,
      height: 3,
      format: IMG_FORMAT_PNG,
      rotation: 0,
      seq: 1,
      timestampUs: 1n,
    };
    expect(isUsablePngFrame({ ...base, image: png })).toBe(true);
    expect(isUsablePngFrame({ ...base, image: Buffer.from("not png") })).toBe(
      false,
    );
    expect(grpcPredecodeMaxFps("png", 60)).toBe(60);
    expect(grpcPredecodeMaxFps("mmap", 60)).toBeUndefined();
  });

  test("treats an empty 0x0 MMAP notification as an inactive-display marker", () => {
    let readCalls = 0;
    const result = readMmapImageNotification(
      {
        width: 0,
        height: 0,
        format: IMG_FORMAT_RGB888,
        rotation: 0,
        image: Buffer.alloc(0),
        seq: 7,
        timestampUs: 1_000_000n,
      },
      () => {
        readCalls++;
        throw new Error("inactive display must not read the MMAP region");
      },
    );

    expect(result).toEqual({ image: null, read: null });
    expect(readCalls).toBe(0);
  });

  test("separates screenshot orientation from active touch rotation", () => {
    const geometry = resolveGrpcDisplayGeometry({
      inputWidth: 288,
      inputHeight: 640,
      nativeWidth: 1080,
      nativeHeight: 2400,
      displayQuarterTurn: 1,
      imageQuarterTurn: 0,
    });

    expect(geometry.encodedSize).toEqual({ width: 640, height: 288 });
    expect(geometry.touchSize).toEqual({ width: 1080, height: 2400 });
    expect(geometry.mapTouch(0.25, 0.75)).toEqual({ x: 270, y: 600 });
    expect(geometry.mapTouch(1, 1)).toEqual({ x: 0, y: 2399 });

    expect(
      resolveGrpcDisplayGeometry({
        inputWidth: 288,
        inputHeight: 640,
        nativeWidth: 1080,
        nativeHeight: 2400,
        displayQuarterTurn: 3,
        imageQuarterTurn: 3,
      }).mapTouch(0.25, 0.75),
    ).toEqual({ x: 810, y: 1800 });

    // Sensor rotation is already represented in the 640x288 screenshot. Its
    // matching rotation metadata cancels the ffmpeg transform, while touch
    // still maps through the full active display rotation.
    const sensorRotated = resolveGrpcDisplayGeometry({
      inputWidth: 640,
      inputHeight: 288,
      nativeWidth: 1080,
      nativeHeight: 2400,
      displayQuarterTurn: 3,
      imageQuarterTurn: 3,
    });
    expect(sensorRotated.quarterTurn).toBe(0);
    expect(sensorRotated.encodedSize).toEqual({ width: 640, height: 288 });
    expect(sensorRotated.mapTouch(0.25, 0.75)).toEqual({
      x: 810,
      y: 1800,
    });

    expect(
      nativeTouchSizeFromEmulatorImage({
        width: 640,
        height: 288,
        rotation: 3,
      }),
    ).toEqual({ width: 288, height: 640 });
  });

  test("drops MMAP notifications during cooldown without a trailing snapshot", () => {
    const clock = new FakeMmapSchedulerClock();
    const diagnostics = new GrpcCaptureDiagnosticsTracker("mmap", 8);
    const consumed: Array<{ seq: number; receivedAtMs: number }> = [];
    const scheduler = new GrpcMmapNotificationScheduler({
      maxFps: 20,
      clock,
      onPacingEvent: (event) => diagnostics.recordGrpcMessage(event),
      consume(image, receivedAtMs) {
        consumed.push({ seq: image.seq, receivedAtMs });
        diagnostics.recordUsableImage(
          { ...image, image: Buffer.alloc(3) },
          receivedAtMs,
          receivedAtMs,
        );
      },
    });
    const push = (image: EmuImage, receivedAtMs: number) => {
      diagnostics.recordGrpcMessage(
        "received",
        { messageBytes: 10, pacingDelayMs: 0 },
        clock.now(),
      );
      scheduler.push(image, receivedAtMs);
    };

    push(mmapNotification(1, 1_000_000n), 1_000);
    expect(consumed).toHaveLength(0);
    clock.flushMicrotasks();
    expect(consumed).toEqual([{ seq: 1, receivedAtMs: 1_000 }]);

    clock.advance(10);
    push(mmapNotification(2, 1_050_000n), 1_010);
    clock.advance(10);
    push(mmapNotification(3, 1_100_000n), 1_020);
    expect(consumed).toHaveLength(1);

    clock.advance(29);
    expect(consumed).toHaveLength(1);
    clock.advance(1);
    expect(consumed).toHaveLength(1);

    push(mmapNotification(4, 1_150_000n), 1_050);
    clock.flushMicrotasks();
    expect(consumed).toEqual([
      { seq: 1, receivedAtMs: 1_000 },
      { seq: 4, receivedAtMs: 1_050 },
    ]);
    expect(diagnostics.snapshot()).toMatchObject({
      rawGrpcMessagesReceived: 4,
      rawGrpcMessagesEmitted: 2,
      rawGrpcMessagesCoalesced: 2,
      usableImages: 2,
      sequenceGaps: 2,
      grpcMessageBytesReceived: 40,
      transportBytes: 6,
    });
    scheduler.close();
  });

  test("selects newest metadata from a synchronous MMAP decode backlog", () => {
    const clock = new FakeMmapSchedulerClock();
    const consumed: number[] = [];
    const events: string[] = [];
    const scheduler = new GrpcMmapNotificationScheduler({
      maxFps: 60,
      clock,
      consume: (image) => consumed.push(image.seq),
      onPacingEvent: (event) => events.push(event),
    });

    scheduler.push(mmapNotification(1, 1n), 1);
    scheduler.push(mmapNotification(2, 2n), 2);
    scheduler.push(mmapNotification(3, 3n), 3);
    expect(consumed).toEqual([]);

    clock.flushMicrotasks();
    expect(consumed).toEqual([3]);
    expect(events).toEqual(["coalesced", "coalesced", "emitted"]);
  });

  test("cancels a pending MMAP snapshot on abort", () => {
    const clock = new FakeMmapSchedulerClock();
    const abort = new AbortController();
    const consumed: number[] = [];
    const scheduler = new GrpcMmapNotificationScheduler({
      maxFps: 10,
      clock,
      signal: abort.signal,
      consume: (image) => consumed.push(image.seq),
    });

    scheduler.push(mmapNotification(1, 1n), 1);
    clock.flushMicrotasks();
    clock.advance(10);
    scheduler.push(mmapNotification(2, 2n), 2);
    abort.abort();
    clock.advance(200);
    scheduler.push(mmapNotification(3, 3n), 3);

    expect(consumed).toEqual([1]);
    expect(() => scheduler.close()).not.toThrow();
  });

  test("does not let a boundary repeat delay the next fresh frame", () => {
    const pacer = new GrpcFrameWritePacer(50);
    pacer.reset(0);
    pacer.recordWrite(0, false, false);
    expect(pacer.waitMs(0)).toBe(0);

    pacer.recordWrite(0, false);
    expect(pacer.waitMs(40)).toBe(10);

    pacer.recordWrite(40, true);
    expect(pacer.waitMs(40)).toBe(10);
    expect(pacer.waitMs(50)).toBe(0);

    pacer.recordWrite(50, false);
    expect(pacer.waitMs(50)).toBe(50);
  });

  test("reports cumulative gRPC capture loss, source timing, and encoder writes", () => {
    const diagnostics = new GrpcCaptureDiagnosticsTracker("mmap", 4);
    const pacingEvents = [
      "received",
      "emitted",
      "received",
      "coalesced",
      "received",
      "emitted",
      "received",
      "coalesced",
      "received",
      "emitted",
    ] as const;
    for (const [index, event] of pacingEvents.entries()) {
      diagnostics.recordGrpcMessage(
        event,
        { messageBytes: 10, pacingDelayMs: 0 },
        100 + index * 10,
      );
    }

    diagnostics.recordUsableImage(
      { seq: 10, timestampUs: 1_000_000n, image: Buffer.alloc(20) },
      1_002,
      1_002,
    );
    diagnostics.recordUsableImage(
      { seq: 12, timestampUs: 1_020_000n, image: Buffer.alloc(22) },
      1_025,
      1_026,
    );
    diagnostics.recordUsableImage(
      { seq: 13, timestampUs: 1_050_000n, image: Buffer.alloc(24) },
      1_057,
      1_058,
    );
    diagnostics.recordImageDecode({ messageBytes: 10, decodeMs: 0.2 });
    diagnostics.recordImageDecode({ messageBytes: 10, decodeMs: 0.4 });
    diagnostics.recordMmapRead({
      image: Buffer.alloc(20),
      attempts: 2,
      bytesRead: 80,
      readMs: 1.5,
    });
    diagnostics.recordMmapRead({
      image: null,
      attempts: 3,
      bytesRead: 144,
      readMs: 2.5,
    });
    diagnostics.recordEncoderWrite(false, true, 24, 2_000);
    diagnostics.recordEncoderWrite(false, false, 24, 2_010);
    diagnostics.recordEncoderWrite(true, true, 24, 2_015);
    diagnostics.recordEncoderWrite(false, true, 24, 2_020);

    expect(diagnostics.snapshot()).toEqual({
      imageMode: "mmap",
      rawGrpcMessagesReceived: 5,
      rawGrpcMessagesEmitted: 3,
      rawGrpcMessagesCoalesced: 2,
      usableImages: 3,
      sourceTimestampFps: 60,
      rawMessageReceiveFps: 50,
      usableImageFps: 35.7,
      freshEncoderWriteFps: 50,
      sequenceGaps: 1,
      imagePayloadBytes: 24,
      transportBytes: 66,
      grpcMessageBytesReceived: 50,
      mmapFileBytesRead: 224,
      mmapReadRetries: 3,
      mmapTornFramesDropped: 1,
      sourceTimestampIntervalMs: {
        windowSamples: 2,
        latest: 30,
        p50: 10,
        p95: 30,
        max: 30,
      },
      rawMessageReceiveIntervalMs: {
        windowSamples: 4,
        latest: 20,
        p50: 20,
        p95: 20,
        max: 20,
      },
      productionToReceiveLatencyMs: {
        windowSamples: 3,
        latest: 7,
        p50: 5,
        p95: 7,
        max: 7,
      },
      productionToUsableLatencyMs: {
        windowSamples: 3,
        latest: 8,
        p50: 6,
        p95: 8,
        max: 8,
      },
      protobufDecodeTimeMs: {
        windowSamples: 2,
        latest: 0.4,
        p50: 0.4,
        p95: 0.4,
        max: 0.4,
      },
      sharedReadCopyTimeMs: {
        windowSamples: 2,
        latest: 2.5,
        p50: 2.5,
        p95: 2.5,
        max: 2.5,
      },
      freshEncoderWriteAttempts: 3,
      repeatEncoderWriteAttempts: 1,
      acceptedEncoderWrites: 3,
      encoderBackpressureRejections: 1,
    });
  });

  test("resets active cadence after a long idle without clearing latency history", () => {
    const diagnostics = new GrpcCaptureDiagnosticsTracker("mmap", 8);
    const image = Buffer.alloc(1);
    const record = (seq: number, timestampUs: bigint, atMs: number) => {
      diagnostics.recordGrpcMessage("received", undefined, atMs);
      diagnostics.recordUsableImage({ seq, timestampUs, image }, atMs, atMs);
      diagnostics.recordEncoderWrite(false, true, image.length, atMs);
    };

    record(1, 1_000_000n, 1_000);
    record(2, 1_020_000n, 1_020);
    expect(diagnostics.snapshot()).toMatchObject({
      sourceTimestampFps: 50,
      rawMessageReceiveFps: 50,
      usableImageFps: 50,
      freshEncoderWriteFps: 50,
    });

    // Three seconds with no source image begins a new active burst. The idle
    // interval itself is not averaged into any cadence window.
    record(3, 4_020_000n, 4_020);
    expect(diagnostics.snapshot()).toMatchObject({
      sourceTimestampFps: null,
      rawMessageReceiveFps: null,
      usableImageFps: null,
      freshEncoderWriteFps: null,
    });
    record(4, 4_045_000n, 4_045);

    expect(diagnostics.snapshot()).toMatchObject({
      sourceTimestampFps: 40,
      rawMessageReceiveFps: 40,
      usableImageFps: 40,
      freshEncoderWriteFps: 40,
      sourceTimestampIntervalMs: {
        windowSamples: 1,
        latest: 25,
        p50: 25,
        p95: 25,
        max: 25,
      },
      rawMessageReceiveIntervalMs: {
        windowSamples: 1,
        latest: 25,
        p50: 25,
        p95: 25,
        max: 25,
      },
      productionToReceiveLatencyMs: { windowSamples: 4 },
      productionToUsableLatencyMs: { windowSamples: 4 },
    });
  });

  test("refreshes native touch size only after the display-size signal changes", async () => {
    let displaySizeOutput =
      "Physical size: 1440x2960\nOverride size: 1080x2220\n";
    let probeCalls = 0;
    let failProbe = false;
    const updates: Array<{ width: number; height: number }> = [];
    const monitor = new GrpcNativeTouchGeometryMonitor({
      initialDisplaySizeSignal: parseDisplaySizeSignal(displaySizeOutput),
      readDisplaySizeSignal: async () =>
        parseDisplaySizeSignal(displaySizeOutput),
      readNativeImage: async () => {
        probeCalls++;
        if (failProbe) throw new Error("PNG probe failed");
        return { width: 1200, height: 2400 };
      },
      onNativeSize: (size) => updates.push(size),
    });
    const signal = new AbortController().signal;

    await monitor.poll(signal);
    await monitor.poll(signal);
    expect(probeCalls).toBe(0);

    displaySizeOutput = "Physical size: 1440x2960\nOverride size: 900x1850\n";
    await monitor.poll(signal);
    expect(probeCalls).toBe(1);
    expect(updates).toEqual([{ width: 1200, height: 2400 }]);

    await monitor.poll(signal);
    expect(probeCalls).toBe(1);

    displaySizeOutput = "Physical size: 1000x2000\n";
    failProbe = true;
    await expect(monitor.poll(signal)).rejects.toThrow("PNG probe failed");
    failProbe = false;
    await monitor.poll(signal);
    expect(probeCalls).toBe(3);
    expect(updates.at(-1)).toEqual({ width: 1200, height: 2400 });
  });

  test("parses bounded physical and override size signals", () => {
    expect(
      parseDisplaySizeSignal(
        "Physical size: 1440x2960\nOverride size: 1080x2220\n",
      ),
    ).toBe("physical:1440x2960;override:1080x2220");
    expect(() => parseDisplaySizeSignal("size unavailable")).toThrow(
      "could not parse emulator display size",
    );
    expect(() => parseDisplaySizeSignal("x".repeat(4_097))).toThrow(
      "display size response exceeds 4096 byte limit",
    );
  });

  test("releases interrupted touch and key downs with a cleanup signal", async () => {
    const calls: Array<{
      kind: "touch" | "key";
      value: unknown;
      signal: AbortSignal | undefined;
    }> = [];
    const interrupted = new AbortController();
    const cleanup = new AbortController();
    let interruptTouch = true;
    let interruptKey = true;
    const input = new GrpcInputState({
      async sendTouch(points, signal) {
        calls.push({ kind: "touch", value: points, signal });
        if (interruptTouch) {
          interruptTouch = false;
          throw new Error("touch interrupted");
        }
      },
      async sendKey(event, signal) {
        calls.push({ kind: "key", value: event, signal });
        if (interruptKey) {
          interruptKey = false;
          throw new Error("key interrupted");
        }
      },
    });

    await expect(
      input.sendTouch(
        [{ x: 120, y: 240, identifier: 7, pressure: 1 }],
        interrupted.signal,
      ),
    ).rejects.toThrow("touch interrupted");
    await expect(
      input.sendKey({ evdev: 29, eventType: "down" }, interrupted.signal),
    ).rejects.toThrow("key interrupted");

    await input.releaseAll(cleanup.signal);

    expect(calls.slice(2).map(({ kind, value }) => ({ kind, value }))).toEqual([
      {
        kind: "touch",
        value: [{ x: 120, y: 240, identifier: 7, pressure: 0 }],
      },
      {
        kind: "key",
        value: { evdev: 29, eventType: "up" },
      },
    ]);
    expect(calls[2]?.signal).toBe(cleanup.signal);
    expect(calls[3]?.signal).toBe(cleanup.signal);
    expect(cleanup.signal.aborted).toBe(false);
  });

  test("rejects the entire non-ASCII text payload before normalization", () => {
    expect(normalizeGrpcText("hello\nworld")).toBe("hello\nworld");
    expect(() => normalizeGrpcText(`${"a".repeat(300)}é`)).toThrow(
      "ASCII text only",
    );

    const parsed = parseGesture({
      type: "text",
      text: `${"a".repeat(300)}é`,
    });
    const compiled = compileGesture(parsed, {
      width: 1080,
      height: 2400,
    }).gesture;
    if (compiled.type !== "text") throw new Error("expected text gesture");
    expect(compiled.text).toBe("a".repeat(300));
    expect(() => normalizeGrpcGestureText(compiled)).toThrow("ASCII text only");
  });

  test("keeps startup recoverable when the initial rotation read fails", async () => {
    const warnings: string[] = [];

    await expect(
      readInitialDisplayRotation(
        () => Promise.reject(new Error("adb queue unavailable")),
        new AbortController().signal,
        (message) => warnings.push(message),
      ),
    ).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("polling for recovery");
  });

  test("does not hide an aborted initial rotation read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("switch cancelled"));

    await expect(
      readInitialDisplayRotation(
        () => Promise.reject(new Error("adb aborted")),
        controller.signal,
      ),
    ).rejects.toThrow("switch cancelled");
  });

  test("becomes ready only after H.264 config and a keyframe", async () => {
    const gate = new H264StartupGate();
    const signal = new AbortController().signal;
    let ready = false;
    const waiting = gate.wait(signal, 1_000).then(() => {
      ready = true;
    });

    gate.observe(SPS_FRAME);
    await Promise.resolve();
    expect(ready).toBe(false);

    gate.observe(KEY_FRAME);
    await Promise.resolve();
    expect(ready).toBe(false);

    gate.observe(PPS_FRAME);
    await waiting;
    expect(ready).toBe(true);
  });

  test("rejects startup when the encoder fails after emitting config", async () => {
    const gate = new H264StartupGate();
    const waiting = gate.wait(new AbortController().signal, 1_000);
    gate.observe(CONFIG_FRAME);
    gate.fail(new Error("ffmpeg exited before producing a keyframe"));

    await expect(waiting).rejects.toThrow(
      "ffmpeg exited before producing a keyframe",
    );
  });

  test("bounds H.264 startup readiness with abort and timeout", async () => {
    const aborted = new AbortController();
    const abortWait = new H264StartupGate().wait(aborted.signal, 1_000);
    aborted.abort(new Error("switch cancelled"));
    await expect(abortWait).rejects.toThrow("switch cancelled");

    await expect(
      new H264StartupGate().wait(new AbortController().signal, 5),
    ).rejects.toThrow("timed out waiting for decodable H.264 output");
  });
});
