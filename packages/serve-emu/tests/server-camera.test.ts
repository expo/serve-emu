import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import {
  cameraFeedPath,
  placeholderCameraImage,
  readCameraFeed,
} from "../src/camera.ts";
import { startServer } from "../src/server.ts";
import { parseCameraStatusResponse } from "../src/shared/api-contracts.ts";
import type { EmuSession } from "../src/stream-session.ts";

const SERIAL = "emulator-5554";

function fakeSession(serial: string): EmuSession {
  let resolveEnd: (value: null) => void = () => {};
  const end = new Promise<null>((resolve) => {
    resolveEnd = resolve;
  });
  const controls = new ControlInputQueue({ writer: { async write() {} } });
  return {
    mode: "scrcpy",
    serial,
    meta: { deviceName: serial, codecId: "h264", width: 720, height: 1280 },
    controls,
    readFrame: () => end,
    onFatal: () => () => {},
    async close() {
      controls.close();
      resolveEnd(null);
    },
  };
}

type CapturedServer = { options: Record<string, unknown> | null };

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
  return fetch(new Request(`http://127.0.0.1:3300${path}`, init), {
    upgrade: () => false,
  });
}

function postImage(
  captured: CapturedServer,
  body: BodyInit,
  query = "",
): Promise<Response> {
  return request(captured, `/api/camera/image${query}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body,
  });
}

async function withServer(
  cameraSerial: string | undefined,
  run: (captured: CapturedServer) => Promise<void>,
): Promise<void> {
  const captured: CapturedServer = { options: null };
  const started = await startServer(
    { serial: SERIAL, port: 3300, cameraSerial },
    {
      openSession: async (options) => fakeSession(options.serial),
      serve: capturingServe(captured),
    },
  );
  try {
    await run(captured);
  } finally {
    await started.stop();
  }
}

let root: string;
const previousRoot = process.env.SERVE_EMU_CAMERA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serve-emu-server-camera-"));
  process.env.SERVE_EMU_CAMERA_DIR = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.SERVE_EMU_CAMERA_DIR;
  else process.env.SERVE_EMU_CAMERA_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("standalone server camera image API", () => {
  test("reports an unwired launch but still names the flags that would wire it", async () => {
    await withServer(undefined, async (captured) => {
      const status = parseCameraStatusResponse(
        await (await request(captured, "/api/camera")).json(),
      ).camera;
      expect(status).toMatchObject({
        serial: SERIAL,
        supported: true,
        wiredAtLaunch: false,
      });
      expect(status.launchArgs).toEqual([
        "-camera-back",
        `imagefile:${cameraFeedPath(SERIAL, "back")}`,
        "-camera-front",
        `imagefile:${cameraFeedPath(SERIAL, "front")}`,
      ]);
      expect(status.feeds.map((feed) => feed.present)).toEqual([false, false]);
    });
  });

  test("POST writes the PNG to the requested facing and DELETE restores the placeholder", async () => {
    await withServer(SERIAL, async (captured) => {
      const png = Buffer.from(placeholderCameraImage().png);
      png.writeUInt32BE(640, 16);
      png.writeUInt32BE(480, 20);

      const posted = parseCameraStatusResponse(
        await (await postImage(captured, Uint8Array.from(png), "?facing=front")).json(),
      ).camera;
      expect(posted.wiredAtLaunch).toBe(true);
      expect(posted.feeds.find((feed) => feed.facing === "front")).toMatchObject({
        present: true,
        placeholder: false,
        width: 640,
        height: 480,
      });
      expect(posted.feeds.find((feed) => feed.facing === "back")?.present).toBe(false);

      const cleared = parseCameraStatusResponse(
        await (
          await request(captured, "/api/camera/image?facing=front", {
            method: "DELETE",
          })
        ).json(),
      ).camera;
      expect(cleared.feeds.find((feed) => feed.facing === "front")).toMatchObject({
        placeholder: true,
        width: 1280,
      });
    });
  });

  test("rejects a non-PNG body and leaves the live feed alone", async () => {
    await withServer(SERIAL, async (captured) => {
      const png = placeholderCameraImage().png;
      expect((await postImage(captured, Uint8Array.from(png))).status).toBe(200);

      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
      const response = await postImage(captured, Uint8Array.from(jpeg));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("PNG only");
      expect((await readCameraFeed(SERIAL, "back")).digest).toBe(
        placeholderCameraImage().digest,
      );
    });
  });

  test("rejects an unknown facing and an unsupported method", async () => {
    await withServer(SERIAL, async (captured) => {
      const bad = await postImage(captured, Uint8Array.from(placeholderCameraImage().png), "?facing=selfie");
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("facing must be one of");

      expect((await request(captured, "/api/camera", { method: "POST" })).status).toBe(405);
      expect(
        (await request(captured, "/api/camera/image", { method: "GET" })).status,
      ).toBe(405);
    });
  });
});
