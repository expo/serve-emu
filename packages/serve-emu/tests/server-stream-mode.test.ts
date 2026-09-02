import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { startServer } from "../src/server.ts";
import type { StreamMode } from "../src/shared/api-contracts.ts";
import type { EmuSession } from "../src/stream-session.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSession(serial: string, mode: StreamMode) {
  const end = deferred<null>();
  let closeCalls = 0;
  const fatalListeners = new Set<
    Parameters<EmuSession["onFatal"]>[0]
  >();
  const controls = new ControlInputQueue({
    writer: { async write() {} },
  });
  const session: EmuSession = {
    mode,
    serial,
    meta: {
      deviceName: `${mode}:${serial}`,
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    controls,
    readFrame: () => end.promise,
    onFatal(listener) {
      fatalListeners.add(listener);
      return () => fatalListeners.delete(listener);
    },
    async close() {
      closeCalls += 1;
      controls.close();
      end.resolve(null);
    },
  };
  return {
    session,
    closeCalls: () => closeCalls,
    fail(message: string) {
      for (const listener of fatalListeners) listener({ message });
    },
  };
}

type CapturedServer = {
  options: Record<string, unknown> | null;
};

function capturingServe(captured: CapturedServer): typeof Bun.serve {
  return ((options: Record<string, unknown>) => {
    captured.options = options;
    return { port: 3300, stop() {} };
  }) as unknown as typeof Bun.serve;
}

function request(
  captured: CapturedServer,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const fetch = captured.options?.fetch as
    | ((request: Request, server: unknown) => Promise<Response>)
    | undefined;
  if (!fetch) throw new Error("server fetch handler was not captured");
  return fetch(
    new Request(`http://127.0.0.1:3300${path}`, init),
    { upgrade: () => false },
  );
}

const putMode = (
  captured: CapturedServer,
  mode: StreamMode,
): Promise<Response> =>
  request(captured, "/api/stream-mode", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

const postJson = (
  captured: CapturedServer,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  request(captured, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("server stream source switching", () => {
  test("uses the shared stream mode request validation", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => initial.session,
        serve: capturingServe(captured),
      },
    );

    const response = await request(captured, "/api/stream-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "screen-copy" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "stream mode request.mode is invalid",
      },
    });

    await started.stop();
  });

  test("rejects an explicit initial gRPC source for a physical device", async () => {
    let openCalls = 0;
    await expect(
      startServer(
        {
          serial: "usb-device",
          port: 3300,
          streamMode: "grpc-screenshot",
        },
        {
          openSession: async () => {
            openCalls += 1;
            return fakeSession("usb-device", "scrcpy").session;
          },
          serve: capturingServe({ options: null }),
        },
      ),
    ).rejects.toThrow(
      "grpc-screenshot is available only for Android Emulator devices",
    );
    expect(openCalls).toBe(0);
  });

  test("stages, publishes, rolls back, and idempotently reports a source", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const grpc = fakeSession("emulator-5554", "grpc-screenshot");
    const grpcGate = deferred<EmuSession>();
    const grpcStarted = deferred<void>();
    const modes: StreamMode[] = [];
    let failScrcpy = false;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async ({ mode }) => {
          modes.push(mode);
          if (modes.length === 1) return initial.session;
          if (mode === "grpc-screenshot") {
            grpcStarted.resolve();
            return grpcGate.promise;
          }
          if (failScrcpy) throw new Error("replacement failed");
          return fakeSession("emulator-5554", mode).session;
        },
        serve: capturingServe(captured),
      },
    );

    expect(await (await request(captured, "/api/stream-mode")).json()).toEqual({
      ok: true,
      serial: "emulator-5554",
      mode: "scrcpy",
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 0,
    });
    const methodNotAllowed = await request(captured, "/api/stream-mode", {
      method: "POST",
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, PUT");
    expect(await methodNotAllowed.json()).toEqual({
      ok: false,
      error: {
        code: "method_not_allowed",
        message: "Method must be GET or PUT",
      },
    });

    const switching = putMode(captured, "grpc-screenshot");
    await grpcStarted.promise;
    expect(initial.closeCalls()).toBe(0);
    expect(
      (await (await request(captured, "/api/stream-mode")).json()).mode,
    ).toBe("scrcpy");

    grpcGate.resolve(grpc.session);
    expect(await (await switching).json()).toMatchObject({
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });
    expect(initial.closeCalls()).toBe(1);

    const idempotent = await putMode(captured, "grpc-screenshot");
    expect(await idempotent.json()).toMatchObject({
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });
    expect(modes).toEqual(["scrcpy", "grpc-screenshot"]);

    failScrcpy = true;
    const failed = await putMode(captured, "scrcpy");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      ok: false,
      error: {
        code: "service_unavailable",
        message: "replacement failed",
      },
    });
    expect(
      (await (await request(captured, "/api/stream-mode")).json()).mode,
    ).toBe("grpc-screenshot");
    expect(grpc.closeCalls()).toBe(0);

    await started.stop();
    expect(grpc.closeCalls()).toBe(1);
  });

  test("preserves same-device recording, location, and active route state across a source switch", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const grpc = fakeSession("emulator-5554", "grpc-screenshot");
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => {
          openCount += 1;
          return openCount === 1 ? initial.session : grpc.session;
        },
        setLocation: async () => {},
        serve: capturingServe(captured),
      },
    );

    expect(
      (
        await postJson(captured, "/api/tap", {
          x: 0.25,
          y: 0.75,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(captured, "/api/location", {
          latitude: 52.3676,
          longitude: 4.9041,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(captured, "/api/route", {
          waypoints: [
            { latitude: 52.3676, longitude: 4.9041 },
            { latitude: 52.52, longitude: 13.405 },
          ],
          speedKph: 1,
          intervalMs: 60_000,
          loop: true,
        })
      ).status,
    ).toBe(200);

    const before = (await (
      await request(captured, "/health")
    ).json()) as {
      location: unknown;
      route: { status: string };
      session: { eventCount: number };
    };
    expect(before.session.eventCount).toBe(2);
    expect(before.route.status).toBe("running");

    expect((await putMode(captured, "grpc-screenshot")).status).toBe(200);

    const after = (await (
      await request(captured, "/health")
    ).json()) as typeof before;
    expect(after.session.eventCount).toBe(2);
    expect(after.location).toEqual(before.location);
    expect(after.route.status).toBe("running");

    await started.stop();
  });

  test("creates fresh device state when switching after a terminal failure", async () => {
    const failed = fakeSession("emulator-5554", "scrcpy");
    const replacement = fakeSession("emulator-5554", "grpc-screenshot");
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () =>
          openCount++ === 0 ? failed.session : replacement.session,
        serve: capturingServe(captured),
      },
    );

    failed.fail("capture process exited");
    expect((await (await request(captured, "/health")).json()).status).toBe(
      "error",
    );

    const response = await putMode(captured, "grpc-screenshot");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await started.stop();
  });

  test("retains device state when the old source fails during replacement startup", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const replacement = fakeSession("emulator-5554", "grpc-screenshot");
    const replacementStart = deferred<EmuSession>();
    const replacementRequested = deferred<void>();
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => {
          openCount += 1;
          if (openCount === 1) return initial.session;
          replacementRequested.resolve(undefined);
          return replacementStart.promise;
        },
        serve: capturingServe(captured),
      },
    );

    const switching = putMode(captured, "grpc-screenshot");
    await replacementRequested.promise;
    initial.fail("capture process exited during replacement startup");
    replacementStart.resolve(replacement.session);

    const response = await switching;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await started.stop();
  });

  test("does not offer or start gRPC capture for a physical device", async () => {
    const physical = fakeSession("usb-device", "scrcpy");
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "usb-device", port: 3300 },
      {
        openSession: async () => physical.session,
        serve: capturingServe(captured),
      },
    );

    expect(await (await request(captured, "/api/stream-mode")).json()).toMatchObject({
      mode: "scrcpy",
      availableModes: ["scrcpy"],
    });
    const response = await putMode(captured, "grpc-screenshot");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message:
          "grpc-screenshot is available only for Android Emulator devices",
      },
    });
    await started.stop();
  });
});
