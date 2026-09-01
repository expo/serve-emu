import { describe, expect, test } from "bun:test";
import {
  GrpcFrameWritePacer,
  GrpcInputState,
  GrpcNativeTouchGeometryMonitor,
  H264StartupGate,
  androidKeyGestureToKeyboardEvents,
  androidKeycodeToW3c,
  isUsableRgbFrame,
  normalizeGrpcGestureText,
  normalizeGrpcText,
  parseDisplaySizeSignal,
  readInitialDisplayRotation,
  resolveGrpcDisplayGeometry,
} from "../src/grpc-session.ts";
import { IMG_FORMAT_RGB888 } from "../src/emulator-grpc.ts";
import { compileGesture, parseGesture } from "../src/input.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

const CONFIG_FRAME: VideoFrame = {
  type: "frame",
  data: Buffer.from([
    0, 0, 0, 1, 0x67, 0x01,
    0, 0, 0, 1, 0x68, 0x01,
  ]),
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
    expect(
      isUsableRgbFrame({ ...base, image: Buffer.alloc(2 * 3 * 3) }),
    ).toBe(true);
    expect(
      isUsableRgbFrame({ ...base, image: Buffer.alloc(2 * 3 * 3 - 1) }),
    ).toBe(false);
    expect(
      isUsableRgbFrame({ ...base, format: 0, image: Buffer.alloc(18) }),
    ).toBe(false);
  });

  test("derives rotated encoded size and logical touch coordinates", () => {
    const geometry = resolveGrpcDisplayGeometry({
      inputWidth: 288,
      inputHeight: 640,
      nativeWidth: 1080,
      nativeHeight: 2400,
      quarterTurn: 1,
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
        quarterTurn: 3,
      }).mapTouch(0.25, 0.75),
    ).toEqual({ x: 810, y: 1800 });
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

    displaySizeOutput =
      "Physical size: 1440x2960\nOverride size: 900x1850\n";
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
      input.sendKey(
        { evdev: 29, eventType: "down" },
        interrupted.signal,
      ),
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
    expect(() => normalizeGrpcGestureText(compiled)).toThrow(
      "ASCII text only",
    );
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
