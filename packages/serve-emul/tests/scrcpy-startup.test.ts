import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import {
  startScrcpy,
  type ScrcpyRuntime,
} from "../src/scrcpy.ts";

class FakeProcess extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly killSignals: string[] = [];

  constructor() {
    super();
  }

  kill(signal?: string): boolean {
    this.killSignals.push(signal ?? "default");
    return true;
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;

  destroy(): this {
    this.destroyCalls += 1;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  emitDataWhenRead(chunks: Buffer[]): void {
    const flush = () => {
      if (this.listenerCount("data") === 0) {
        queueMicrotask(flush);
        return;
      }
      for (const chunk of chunks) this.emit("data", chunk);
    };
    queueMicrotask(flush);
  }
}

type FailurePoint =
  | "ensure"
  | "push"
  | "forward"
  | "spawn"
  | "spawn-async"
  | "spawn-exit"
  | "process-error-connect"
  | "wait"
  | "connect-first"
  | "connect-second"
  | "preamble";

function v4Preamble(): Buffer {
  const name = Buffer.alloc(64);
  name.write("Fake Pixel", "utf8");
  const metadata = Buffer.alloc(16);
  metadata.writeUInt32BE(0x68323634, 0);
  metadata.writeUInt32BE(0x80000000, 4);
  metadata.writeUInt32BE(720, 8);
  metadata.writeUInt32BE(1280, 12);
  return Buffer.concat([Buffer.of(0), name, metadata]);
}

function makeHarness(failure?: FailurePoint) {
  const proc = new FakeProcess();
  const video = new FakeSocket();
  const control = new FakeSocket();
  const removed: Array<[string, number]> = [];
  const spawnedArgs: string[][] = [];
  let connectCalls = 0;
  let waitAbortCalls = 0;
  let connectAbortCalls = 0;

  const runtime: ScrcpyRuntime = {
    ensureServer: async () => {
      if (failure === "ensure") throw new Error("ensure failed");
      return "/fake/scrcpy-server.jar";
    },
    pushServer: () => {
      if (failure === "push") throw new Error("push failed");
    },
    createForward: () => {
      if (failure === "forward") throw new Error("forward failed");
      return 27183;
    },
    spawnServer: (_serial, args) => {
      if (failure === "spawn") throw new Error("spawn failed");
      spawnedArgs.push(args);
      if (failure === "spawn-async") {
        queueMicrotask(() => proc.emit("error", new Error("adb missing")));
      }
      if (failure === "spawn-exit") {
        queueMicrotask(() => proc.emit("exit", 1, null));
      }
      return proc as unknown as ChildProcess;
    },
    waitForSocket: async (_serial, _name, signal) => {
      if (failure === "spawn-async" || failure === "spawn-exit") {
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              waitAbortCalls++;
              reject(new Error("wait aborted"));
            },
            { once: true },
          );
        });
      }
      if (failure === "wait") throw new Error("wait failed");
    },
    connect: async (_port, signal) => {
      connectCalls += 1;
      if (failure === "process-error-connect" && connectCalls === 1) {
        queueMicrotask(() => proc.emit("error", new Error("adb exited")));
        return new Promise<Socket>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              connectAbortCalls++;
              video.destroy();
              reject(new Error("connect aborted"));
            },
            { once: true },
          );
        });
      }
      if (failure === "connect-first" && connectCalls === 1) {
        throw new Error("first connect failed");
      }
      if (failure === "connect-second" && connectCalls === 2) {
        throw new Error("second connect failed");
      }
      if (connectCalls === 2) {
        const preamble =
          failure === "preamble" ? Buffer.alloc(81, 0xff) : v4Preamble();
        video.emitDataWhenRead([
          preamble.subarray(0, 1),
          preamble.subarray(1, 23),
          preamble.subarray(23, 79),
          preamble.subarray(79),
        ]);
      }
      return (connectCalls === 1 ? video : control) as unknown as Socket;
    },
    removeForward: (serial, port) => {
      removed.push([serial, port]);
    },
    createScid: () => "0123abcd",
  };

  return {
    runtime,
    proc,
    video,
    control,
    removed,
    spawnedArgs,
    get connectCalls() {
      return connectCalls;
    },
    get waitAbortCalls() {
      return waitAbortCalls;
    },
    get connectAbortCalls() {
      return connectAbortCalls;
    },
  };
}

async function startFailure(failure: FailurePoint) {
  const harness = makeHarness(failure);
  const error = await startScrcpy(
    { serial: "emulator-5554" },
    harness.runtime,
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  return harness;
}

describe("startScrcpy rollback", () => {
  test.each(["ensure", "push"] as const)(
    "%s failure occurs before resources are acquired",
    async (failure) => {
      const harness = await startFailure(failure);
      expect(harness.proc.killSignals).toEqual([]);
      expect(harness.video.destroyCalls).toBe(0);
      expect(harness.control.destroyCalls).toBe(0);
      expect(harness.removed).toEqual([]);
    },
  );

  test("forward failure owns no resources and performs no speculative cleanup", async () => {
    const harness = await startFailure("forward");
    expect(harness.proc.killSignals).toEqual([]);
    expect(harness.video.destroyCalls).toBe(0);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([]);
  });

  test("spawn failure removes the acquired forward exactly once", async () => {
    const harness = await startFailure("spawn");
    expect(harness.proc.killSignals).toEqual([]);
    expect(harness.video.destroyCalls).toBe(0);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("an asynchronous child-process error rejects startup and rolls back", async () => {
    const harness = await startFailure("spawn-async");
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(0);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
    expect(harness.waitAbortCalls).toBe(1);
  });

  test("an early child-process exit aborts the wait and rolls back", async () => {
    const harness = await startFailure("spawn-exit");
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
    expect(harness.waitAbortCalls).toBe(1);
  });

  test("a process error cancels and destroys an in-flight connection", async () => {
    const harness = await startFailure("process-error-connect");
    expect(harness.connectAbortCalls).toBe(1);
    expect(harness.video.destroyCalls).toBe(1);
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("socket wait failure kills the process and removes the forward", async () => {
    const harness = await startFailure("wait");
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(0);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("first connect failure rolls back process and forward", async () => {
    const harness = await startFailure("connect-first");
    expect(harness.connectCalls).toBe(1);
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(0);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("second connect failure also destroys the opened video socket", async () => {
    const harness = await startFailure("connect-second");
    expect(harness.connectCalls).toBe(2);
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(1);
    expect(harness.control.destroyCalls).toBe(0);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("preamble failure destroys both sockets, kills, and un-forwards once", async () => {
    const harness = await startFailure("preamble");
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(1);
    expect(harness.control.destroyCalls).toBe(1);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });

  test("successful startup keeps public metadata and close is idempotent", async () => {
    const harness = makeHarness();
    const session = await startScrcpy(
      { serial: "emulator-5554" },
      harness.runtime,
    );

    expect(session.meta).toEqual({
      deviceName: "Fake Pixel",
      codecId: "h264",
      width: 720,
      height: 1280,
    });
    expect(session.protocol).toBe(4);
    expect(session.scid).toBe("0123abcd");
    expect(harness.spawnedArgs[0]).toContain("send_dummy_byte=true");

    session.close();
    session.close();
    expect(harness.proc.killSignals).toEqual(["SIGKILL"]);
    expect(harness.video.destroyCalls).toBe(1);
    expect(harness.control.destroyCalls).toBe(1);
    expect(harness.removed).toEqual([["emulator-5554", 27183]]);
  });
});
