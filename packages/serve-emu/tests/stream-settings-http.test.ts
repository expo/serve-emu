import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/middleware.ts";
import type { ScrcpySession, StartOpts } from "../src/scrcpy.ts";
import type { StreamSocket } from "../src/stream-socket.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestStreamSocket implements StreamSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  bufferedAmount = 0;
  private messageHandler: ((text: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.closeHandler?.();
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  receive(message: string): void {
    this.messageHandler?.(message);
  }
}

function fakeSession(
  size: { width: number; height: number } = { width: 1080, height: 1920 },
  onControlWrite?: (data: string | Uint8Array) => void,
): ScrcpySession {
  const proc = new EventEmitter();
  const controlSocket = Object.assign(new EventEmitter(), {
    write: (data: string | Uint8Array) => {
      onControlWrite?.(data);
      return true;
    },
  });

  return {
    transport: "scrcpy",
    meta: {
      deviceName: "Pixel Test",
      codecId: "h264",
      width: size.width,
      height: size.height,
    },
    protocol: 4,
    videoReader: {} as ScrcpySession["videoReader"],
    controlSocket: controlSocket as unknown as ScrcpySession["controlSocket"],
    proc: proc as ScrcpySession["proc"],
    scid: "00000001",
    localPort: 27_200,
    serial: "emulator-test",
    readFrame: () => new Promise(() => {}),
    close: async () => {},
  };
}

describe("stream settings HTTP API", () => {
  test("GET /api/stream-settings reports the active scrcpy encoder settings", async () => {
    const starts: StartOpts[] = [];
    const app = await createApp(
      {
        serial: "emulator-test",
        maxSize: 960,
        bitRate: 4_000_000,
        maxFps: 24,
      },
      {
        startScrcpy: async (options: StartOpts) => {
          starts.push(options);
          return fakeSession();
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        maxDimension: 960,
        h264Bitrate: 4_000_000,
        h264Fps: 24,
      });
      expect(starts).toHaveLength(1);
      expect(starts[0]).toEqual({
        serial: "emulator-test",
        maxSize: 960,
        bitRate: 4_000_000,
        maxFps: 24,
        keyFrameInterval: undefined,
      });
    } finally {
      app.stop();
    }
  });

  test("PATCH /api/stream-settings replaces capture and reports its authoritative settings", async () => {
    const starts: StartOpts[] = [];
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts.push(options);
          return fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          );
        },
      },
    );
    const initialSession = app.session;

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            maxDimension: 720,
            h264Bitrate: 3_000_000,
            h264Fps: 20,
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        maxDimension: 720,
        h264Bitrate: 3_000_000,
        h264Fps: 20,
      });

      const status = await app.handleRequest(new Request("http://localhost/api"));
      expect((await status.json()).size).toEqual({ width: 405, height: 720 });
      expect(app.session).not.toBe(initialSession);
      expect(app.session.meta).toMatchObject({ width: 405, height: 720 });
      expect(starts[1]).toEqual({
        serial: "emulator-test",
        maxSize: 720,
        bitRate: 3_000_000,
        maxFps: 20,
        keyFrameInterval: undefined,
      });
    } finally {
      app.stop();
    }
  });

  test("an attached WebSocket client survives capture replacement and receives the new video session", async () => {
    const replacementControlWrites: Buffer[] = [];
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) =>
          fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
            options.maxSize === 720
              ? (data) => replacementControlWrites.push(Buffer.from(data))
              : undefined,
          ),
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );

      expect(response.status).toBe(200);
      expect(socket.closes).toEqual([]);
      expect(
        socket.sent
          .filter((message): message is string => typeof message === "string")
          .map((message) => JSON.parse(message)),
      ).toContainEqual({
        type: "video-session",
        size: { width: 405, height: 720 },
      });
      expect(replacementControlWrites).toContainEqual(Buffer.from([17]));
    } finally {
      app.stop();
    }
  });

  test("PATCH rejects unknown, non-integer, and out-of-range settings without changing capture", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          return fakeSession();
        },
      },
    );

    try {
      for (const patch of [
        { maxDimension: 4_097 },
        { h264Bitrate: 99_999 },
        { h264Fps: 24.5 },
        { resolution: 720 },
      ]) {
        const response = await app.handleRequest(
          new Request("http://localhost/api/stream-settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }),
        );

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("invalid_stream_settings");
      }

      const settings = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );
      expect(await settings.json()).toEqual({
        maxDimension: 1280,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(starts).toBe(1);
    } finally {
      app.stop();
    }
  });

  test("PATCH requires an application/json body", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      { startScrcpy: async () => fakeSession() },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "unsupported_media_type" });
    } finally {
      app.stop();
    }
  });

  test("a failed replacement rolls capture back to the previous authoritative settings", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test", maxSize: 960 },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          if (options.maxSize === 720) throw new Error("encoder rejected requested size");
          return fakeSession({ width: 540, height: 960 });
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );

      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe("stream_settings_failed");

      const settings = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );
      expect(await settings.json()).toEqual({
        maxDimension: 960,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      const health = await app.handleRequest(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect((await health.json()).size).toEqual({ width: 540, height: 960 });
      expect(starts).toBe(3);
    } finally {
      app.stop();
    }
  });

  test("exit and socket errors from the replaced generation cannot terminate the new capture", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          const capture = fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          );
          if (starts === 1) {
            capture.close = async () => {
              capture.proc.emit("exit", 0, null);
              capture.controlSocket.emit("error", new Error("stale control error"));
            };
          }
          return capture;
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );

      expect(response.status).toBe(200);
      const health = await app.handleRequest(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect((await health.json()).size).toEqual({ width: 405, height: 720 });
    } finally {
      app.stop();
    }
  });

  test("concurrent PATCH requests serialize capture restarts", async () => {
    const firstReplacement = deferred<ScrcpySession>();
    const firstReplacementStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          if (starts === 1) return fakeSession();
          if (starts === 2) {
            firstReplacementStarted.resolve();
            return firstReplacement.promise;
          }
          return fakeSession(
            options.maxSize === 960
              ? { width: 540, height: 960 }
              : { width: 405, height: 720 },
          );
        },
      },
    );

    try {
      const firstPatch = app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );
      await firstReplacementStarted.promise;
      const secondPatch = app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 960 }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(starts).toBe(2);
      firstReplacement.resolve(fakeSession({ width: 405, height: 720 }));

      expect(await (await firstPatch).json()).toEqual({
        maxDimension: 720,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(await (await secondPatch).json()).toEqual({
        maxDimension: 960,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(starts).toBe(3);
    } finally {
      app.stop();
    }
  });

  test("input is rejected while the old control socket is closed for replacement", async () => {
    const replacement = deferred<ScrcpySession>();
    const replacementStarted = deferred<void>();
    let starts = 0;
    let oldControlWrites = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) {
            const initial = fakeSession();
            initial.controlSocket.write = () => {
              oldControlWrites++;
              return true;
            };
            return initial;
          }
          replacementStarted.resolve();
          return replacement.promise;
        },
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });
    const writesBeforeRestart = oldControlWrites;

    const patch = app.handleRequest(
      new Request("http://localhost/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDimension: 720 }),
      }),
    );
    await replacementStarted.promise;
    socket.receive(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldControlWrites).toBe(writesBeforeRestart);
    expect(
      socket.sent
        .filter((message): message is string => typeof message === "string")
        .map((message) => JSON.parse(message)),
    ).toContainEqual({ ok: false, error: "Error: video capture is restarting" });

    replacement.resolve(fakeSession({ width: 405, height: 720 }));
    expect((await patch).status).toBe(200);
    app.stop();
  });

  test("input already in flight is not acknowledged or recorded after capture changes", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) =>
          fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          ),
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });

    try {
      socket.receive(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const messages = socket.sent
        .filter((message): message is string => typeof message === "string")
        .map((message) => JSON.parse(message));
      expect(messages).toContainEqual({
        ok: false,
        error: "Error: video capture restarted during input",
      });
      expect(messages).not.toContainEqual({ ok: true });
      const session = await app.handleRequest(new Request("http://localhost/api/session"));
      expect((await session.json()).events).toEqual([]);
    } finally {
      app.stop();
    }
  });

  test("stopping during replacement closes a late capture instead of activating it", async () => {
    const replacement = deferred<ScrcpySession>();
    const replacementStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) return fakeSession();
          replacementStarted.resolve();
          return replacement.promise;
        },
      },
    );

    const patch = app.handleRequest(
      new Request("http://localhost/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDimension: 720 }),
      }),
    );
    await replacementStarted.promise;
    app.stop();
    let closed = 0;
    const lateCapture = fakeSession({ width: 405, height: 720 });
    lateCapture.close = async () => {
      closed++;
    };
    replacement.resolve(lateCapture);

    const response = await patch;
    expect(response.status).toBe(500);
    expect(closed).toBe(1);
    expect(app.isStreaming()).toBe(false);
    expect(app.health().captureRestarting).toBe(false);
  });

  test("stopping during rollback closes a late rollback capture", async () => {
    const rollback = deferred<ScrcpySession>();
    const rollbackStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) return fakeSession();
          if (starts === 2) throw new Error("replacement failed");
          rollbackStarted.resolve();
          return rollback.promise;
        },
      },
    );

    const patch = app.handleRequest(
      new Request("http://localhost/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDimension: 720 }),
      }),
    );
    await rollbackStarted.promise;
    app.stop();
    let closed = 0;
    const lateRollback = fakeSession();
    lateRollback.close = async () => {
      closed++;
    };
    rollback.resolve(lateRollback);

    const response = await patch;
    expect(response.status).toBe(500);
    expect(closed).toBe(1);
    expect(app.isStreaming()).toBe(false);
    expect(app.health().captureRestarting).toBe(false);
  });
});
