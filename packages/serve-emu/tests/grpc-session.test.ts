import { describe, expect, test } from "bun:test";
import {
  H264StartupGate,
  androidKeyGestureToKeyboardEvents,
  androidKeycodeToW3c,
  isUsableRgbFrame,
} from "../src/grpc-session.ts";
import { IMG_FORMAT_RGB888 } from "../src/emulator-grpc.ts";
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
