import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import {
  startServer,
  type ServerRuntime,
} from "../src/server.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";

function fakeSession() {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const control = new EventEmitter() as unknown as Socket;
  const closeCalls: string[] = [];
  const session = {
    transport: "scrcpy",
    meta: {
      deviceName: "Fake Pixel",
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    protocol: 4,
    videoReader: null,
    controlSocket: control,
    proc,
    scid: "0123abcd",
    localPort: 27183,
    serial: "emulator-5554",
    readFrame: () => new Promise<never>(() => {}),
    close: () => closeCalls.push("close"),
  } as unknown as ScrcpySession;
  return { session, closeCalls };
}

describe("server startup lifecycle", () => {
  test("a Bun bind failure rolls back the opened session and watchdog", async () => {
    const { session, closeCalls } = fakeSession();
    const timer = {};
    const cleared: unknown[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        startServer({
          serial: "emulator-5554",
          port: 3300,
          runtime: {
            openScrcpy: async () => session,
            serve: (() => {
              throw new Error("address already in use");
            }) as typeof Bun.serve,
            setInterval: () => timer,
            clearInterval: (handle) => cleared.push(handle),
          },
        }),
      ).rejects.toThrow("address already in use");
    } finally {
      log.mockRestore();
    }

    expect(closeCalls).toEqual(["close"]);
    expect(cleared).toEqual([timer]);
  });

  test("the real fetch composition returns a structured body-limit failure", async () => {
    const { session, closeCalls } = fakeSession();
    const holder: {
      options?: {
        fetch(
          request: Request,
          server: { upgrade(): boolean },
        ): Response | Promise<Response | undefined> | undefined;
      };
    } = {};
    let stopped = 0;
    const cleared: unknown[] = [];
    const timer = {};
    const fakeServer = {
      stop() {
        stopped++;
      },
    };
    const runtime: Partial<ServerRuntime> = {
      openScrcpy: async () => session,
      serve: ((options: unknown) => {
        holder.options = options as typeof holder.options;
        return fakeServer;
      }) as typeof Bun.serve,
      setInterval: () => timer,
      clearInterval: (handle) => cleared.push(handle),
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const started = await startServer({
      serial: "emulator-5554",
      port: 3300,
      runtime,
    });
    log.mockRestore();

    const response = await holder.options?.fetch(
      new Request("http://localhost:3300/api/tap", {
        method: "POST",
        body: JSON.stringify({ data: "x".repeat(9_000) }),
      }),
      { upgrade: () => false },
    );
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      ok: false,
      error: {
        code: "payload_too_large",
        message: "Request body is too large",
      },
    });

    session.proc.emit("error", new Error("adb vanished"));
    const health = await holder.options?.fetch(
      new Request("http://localhost:3300/health"),
      { upgrade: () => false },
    );
    expect(health?.status).toBe(503);
    expect(await health?.json()).toMatchObject({
      status: "error",
      lastError: "scrcpy process error: adb vanished",
      lastErrorCode: "process-error",
    });
    expect(closeCalls).toEqual(["close"]);
    expect(cleared).toEqual([timer]);

    started.stop();
    expect(stopped).toBe(1);
    expect(closeCalls).toEqual(["close"]);
    expect(cleared).toEqual([timer]);
  });
});
