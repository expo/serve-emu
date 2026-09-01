import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import {
  adaptScrcpySession,
  startEmuSession,
} from "../src/stream-session.ts";

function fakeScrcpy(close: () => unknown = () => {}): {
  raw: ScrcpySession;
  proc: EventEmitter;
  control: EventEmitter;
} {
  const proc = new EventEmitter();
  const control = new EventEmitter();
  return {
    proc,
    control,
    raw: {
      transport: "scrcpy",
      serial: "emulator-5554",
      meta: {
        deviceName: "fake",
        codecId: "h264",
        width: 576,
        height: 1280,
      },
      proc,
      controlSocket: control,
      readFrame: async () => null,
      close,
    } as unknown as ScrcpySession,
  };
}

describe("stream session", () => {
  test("rejects strict gRPC selection for physical devices", async () => {
    await expect(
      startEmuSession({
        mode: "grpc-screenshot",
        serial: "physical-device",
      }),
    ).rejects.toThrow("requires an Android Emulator serial");
  });

  test("adapts scrcpy controls, failures, and void cleanup", async () => {
    const packets: Buffer[] = [];
    let writerClosed = false;
    let rawClosed = 0;
    const controls = new ControlInputQueue({
      writer: {
        async write(packet) {
          packets.push(packet);
        },
        close() {
          writerClosed = true;
        },
      },
    });
    const { raw, proc } = fakeScrcpy(() => {
      rawClosed++;
    });
    const session = adaptScrcpySession(raw, controls);
    const failures: string[] = [];
    const unsubscribe = session.onFatal((failure) =>
      failures.push(failure.message),
    );

    await session.controls.enqueueVideoReset().completion;
    proc.emit("exit", 9, null);
    expect(session.mode).toBe("scrcpy");
    expect(session.rawScrcpy).toBe(raw);
    expect(packets).toEqual([Buffer.from([17])]);
    expect(failures).toEqual([
      "scrcpy exited with code 9 signal null",
    ]);

    unsubscribe();
    proc.emit("exit", 10, null);
    expect(failures).toHaveLength(1);
    await session.close();
    await session.close();
    expect(rawClosed).toBe(1);
    expect(writerClosed).toBe(true);
  });
});
