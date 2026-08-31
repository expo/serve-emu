import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  getUserRotation,
  listAllDevices,
  listDevices,
  screencapPng,
  setUserRotation,
  type OrientationMode,
} from "./adb.ts";
import { getAccessibilitySnapshot } from "./accessibility.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  launchApp,
} from "./app-management.ts";
import { getForegroundApp } from "./app-info.ts";
import { loadDeviceGrid } from "./device-grid.ts";
import {
  listAvds,
  listRunningAvds,
  resolveRunningAvds,
  startEmulator,
  stopEmulator,
} from "./emulator.ts";
import { getNightMode, isNightMode, setNightMode } from "./ui-mode.ts";
import { startScrcpy, type ScrcpySession } from "./scrcpy.ts";
import { dispatch, parseGesture, resetVideoPacket, type Gesture, type Screen } from "./input.ts";
import { parseGeoFix, setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { parseRoutePlaybackRequest, RoutePlayback } from "./route-playback.ts";
import { SessionRecorder } from "./session-recorder.ts";
import type { StreamSocket } from "./stream-socket.ts";
import {
  DEFAULT_STREAM_SETTINGS,
  redactedStreamSettings,
  type StreamSettings,
} from "./stream-settings.ts";
import {
  corsHeadersForRequest,
  isAllowedBrowserOrigin,
  type BrowserOriginPolicy,
} from "./origin-policy.ts";
import {
  MAX_WEBRTC_SIGNALING_BODY_BYTES,
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
} from "./webrtc-signaling.ts";
import { createWebRtcPublisher, type WebRtcPublisher } from "./webrtc-publisher.ts";
import { HttpBodyError, readBodyLimited, readJsonLimited } from "./request-body.ts";
import { createMiddlewareUploader } from "./middleware-upload.ts";

export { fromBunSocket, fromWsSocket } from "./stream-socket.ts";
export type { StreamSocket, WsWebSocketLike } from "./stream-socket.ts";
export { pickDevice } from "./adb.ts";
export type { ScrcpySession } from "./scrcpy.ts";
export type {
  StreamSettings,
  WebRtcIceServer,
  WebRtcIceTransportPolicy,
} from "./stream-settings.ts";

const here = dirname(fileURLToPath(import.meta.url));
// `src/middleware.ts` and `dist/middleware.mjs` both resolve to `<pkg>/dist/ui`.
const UI_DIR = join(here, "..", "dist", "ui");

export type AppOptions = {
  serial: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
  streamSettings?: StreamSettings;
} & BrowserOriginPolicy;

type SessionStatus = "streaming" | "stopped" | "error";

type Client = {
  id: number;
  socket: StreamSocket;
  video: boolean;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;
const VIDEO_RESET_COOLDOWN_MS = 1500;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WEBRTC_CLOSE_BODY_BYTES = 4 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;
// After a device's scrcpy start fails, wait this long before retrying so a
// flapping device doesn't get hammered on every request.
const SPAWN_RETRY_COOLDOWN_MS = 5_000;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Serve a file from the built UI directory. Returns `null` when the path does
 * not map to a real file so callers can fall back to a 404. The UI shell is
 * device-independent, so the router serves it without a device attached.
 */
function serveStaticFile(pathname: string): Response | null {
  const reqPath = pathname === "/" ? "/index.html" : pathname;
  if (reqPath.includes("..")) return null;
  const filePath = join(UI_DIR, reqPath);
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return new Response(new Uint8Array(readFileSync(filePath)), {
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  }
  return null;
}

/**
 * Build a transport-agnostic serve-emu app for one device: starts scrcpy, owns
 * the client set + video fan-out, and exposes a fetch-style `handleRequest` plus
 * an `attachWebSocket` for the H.264/gesture channel. `server.ts` (Bun) and the
 * Expo DevTools plugin both mount these onto their own transport.
 */
export async function createApp(opts: AppOptions) {
  const uploader = createMiddlewareUploader({
    serial: opts.serial,
    maxApkUploadBytes: opts.maxApkUploadBytes,
    maxMediaUploadBytes: opts.maxMediaUploadBytes,
    maxActiveUploads: opts.maxActiveUploads,
    maxQueuedUploads: opts.maxQueuedUploads,
    uploadQueueTimeoutMs: opts.uploadQueueTimeoutMs,
  });
  let session: ScrcpySession;
  try {
    session = await startScrcpy({
      serial: opts.serial,
      maxFps: opts.maxFps,
      bitRate: opts.bitRate,
      maxSize: opts.maxSize,
      keyFrameInterval: opts.keyFrameInterval,
    });
  } catch (error) {
    await uploader.close(error);
    throw error;
  }

  const clients = new Set<Client>();
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
  const streamSettings = opts.streamSettings ?? DEFAULT_STREAM_SETTINGS;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let frameCount = 0;
  let configPacketCount = 0;
  let lastFrameMs = 0;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let pendingVideoResetTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingVideoResetReason: string | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastLocation: (GeoFix & { appliedAt: string }) | null = null;
  let nextClientId = 1;
  let webRtcPublisher: WebRtcPublisher | null = null;
  const sessionRecorder = new SessionRecorder();
  const routePlayback = new RoutePlayback({
    applyLocation: (fix) => setEmulatorLocationAsync(opts.serial, fix),
    onLocation: (fix) => {
      lastLocation = fix;
    },
  });

  const health = () => ({
    ok: status === "streaming",
    status,
    serial: opts.serial,
    device: session.meta.deviceName,
    codec: session.meta.codecId,
    size: { width: screen.width, height: screen.height },
    clients: clients.size,
    videoClients: Array.from(clients).filter((client) => client.video).length,
    frames: frameCount,
    sourceFps,
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    location: lastLocation,
    route: routePlayback.snapshot(),
    session: sessionRecorder.snapshot(),
    uploads: uploader.snapshot(),
    stream: redactedStreamSettings(streamSettings),
    webrtc: webRtcPublisher?.snapshot() ?? null,
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      video: client.video,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.socket.bufferedAmount,
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
    lastError,
  });

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.socket.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const markTerminal = (nextStatus: Exclude<SessionStatus, "streaming">, reason: string) => {
    if (status !== "streaming") return;
    status = nextStatus;
    lastError = reason;
    stoppedAt = new Date().toISOString();
    if (watchdog) clearInterval(watchdog);
    if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
    pendingVideoResetTimer = null;
    pendingVideoResetReason = null;
    routePlayback.close();
    webRtcPublisher?.close();
    void uploader.close(new Error(reason));
    session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (socket: StreamSocket, value: unknown) => {
    try {
      socket.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(FRAME_META_HEADER_BYTES + configBytes + frameData.length);
    out.writeUInt32BE(FRAME_META_MAGIC, 0);
    out.writeUInt8(FRAME_META_VERSION, 4);
    out.writeUInt8(frame.isKey ? FRAME_FLAG_KEY : 0, 5);
    out.writeUInt16BE(0, 6);
    out.writeBigUInt64BE(frame.pts, 8);
    if (config) config.copy(out, FRAME_META_HEADER_BYTES);
    frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
    return out;
  };

  const withConfig = (frameData: Buffer, config: Buffer | null): Buffer => {
    if (!config) return frameData;
    const out = Buffer.allocUnsafe(config.length + frameData.length);
    config.copy(out, 0);
    frameData.copy(out, config.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const readJsonBody = async (req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> => {
    return readJsonLimited(req, maxBytes);
  };

  const readBodyText = async (req: Request, maxBytes: number): Promise<string> => {
    try {
      const body = await readBodyLimited(req, maxBytes);
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch (err) {
      if (
        err instanceof HttpBodyError &&
        (err.code === "payload-too-large" || err.code === "too-many-body-chunks")
      ) {
        throw new WebRtcSignalingError("WebRTC signaling body is too large", 413, "request_too_large");
      }
      throw err;
    }
  };

  const parseJsonBody = (body: string, code: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      throw new WebRtcSignalingError("Invalid JSON body", 400, code);
    }
  };

  const isJsonRequest = (req: Request): boolean => {
    const contentType = req.headers.get("content-type");
    return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  };

  const shouldRecord = (value: unknown) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).record !== false;

  const dispatchGesture = async (gesture: Gesture, source: string, record = true) => {
    if (status !== "streaming") throw new Error(`session is ${status}`);
    await dispatch(session.controlSocket, gesture, screen);
    if (record) sessionRecorder.recordGesture(gesture, source);
  };

  const applyLocation = async (fix: GeoFix, source: string, record = true) => {
    routePlayback.stop();
    await setEmulatorLocationAsync(opts.serial, fix);
    lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (record) sessionRecorder.recordLocation(fix, source);
    return lastLocation;
  };

  const resolvePackagePids = (packageName: string): Set<string> => {
    if (!/^[A-Za-z0-9_.:-]+$/.test(packageName)) return new Set();
    const r = spawnSync("adb", ["-s", opts.serial, "shell", "pidof", packageName], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (r.status !== 0) return new Set();
    return new Set(r.stdout.trim().split(/\s+/).filter(Boolean));
  };

  const logcatStream = (req: Request, url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES).toLowerCase();
    const proc = spawn("adb", ["-s", opts.serial, "logcat", "-v", "threadtime"]);
    const encoder = new TextEncoder();
    let pidSet = packageName ? resolvePackagePids(packageName) : new Set<string>();
    let pidTimer: ReturnType<typeof setInterval> | null = null;
    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, value: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
            );
          } catch {}
        };
        const matches = (line: string) => {
          if (search && !line.toLowerCase().includes(search)) return false;
          if (!packageName) return true;
          const parts = line.trim().split(/\s+/, 5);
          const pid = parts[2];
          return (pid && pidSet.has(pid)) || line.includes(packageName);
        };
        const consume = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line && matches(line)) send("log", { line, at: new Date().toISOString() });
          }
        };

        send("ready", {
          serial: opts.serial,
          package: packageName || null,
          pids: Array.from(pidSet),
          search: search || null,
        });
        if (packageName) {
          pidTimer = setInterval(() => {
            pidSet = resolvePackagePids(packageName);
          }, 5_000);
        }
        proc.stdout.on("data", consume);
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8").trim();
          if (text) send("error", { line: text, at: new Date().toISOString() });
        });
        proc.once("exit", (code, signal) => {
          send("close", { code, signal });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
        proc.once("error", (err) => {
          send("error", { line: err.message, at: new Date().toISOString() });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
      },
      cancel() {
        if (pidTimer) clearInterval(pidTimer);
        try {
          proc.kill("SIGTERM");
        } catch {}
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeadersForRequest(req, opts, "GET"),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  };

  const gestureEndpoint = async (req: Request, type: Gesture["type"], source: string) => {
    try {
      const payload = await readJsonBody(req);
      const gesture = parseGesture(
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      await dispatchGesture(gesture, source, shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const keyEndpoint = async (req: Request) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      await dispatchGesture(gesture, "rest:key", shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const appJsonEndpoint = async (
    req: Request,
    action: (payload: Record<string, unknown>) => unknown,
  ) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("payload must be an object");
      }
      const result = await action(payload as Record<string, unknown>);
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const installEndpoint = (req: Request) => uploader.install(req);

  const fileImportEndpoint = (req: Request) => uploader.importFile(req);

  const performVideoReset = (reason: string) => {
    const now = Date.now();
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      session.controlSocket.write(resetVideoPacket());
    } catch {}
  };

  const requestVideoReset = (reason: string) => {
    if (status !== "streaming") return;
    const now = Date.now();
    const remainingCooldownMs = VIDEO_RESET_COOLDOWN_MS - (now - lastVideoResetMs);
    if (remainingCooldownMs <= 0) {
      if (pendingVideoResetTimer) {
        clearTimeout(pendingVideoResetTimer);
        pendingVideoResetTimer = null;
        pendingVideoResetReason = null;
      }
      performVideoReset(reason);
      return;
    }

    pendingVideoResetReason = reason;
    if (pendingVideoResetTimer) return;
    pendingVideoResetTimer = setTimeout(() => {
      pendingVideoResetTimer = null;
      const pendingReason = pendingVideoResetReason;
      pendingVideoResetReason = null;
      if (pendingReason) performVideoReset(pendingReason);
    }, remainingCooldownMs);
  };

  if (streamSettings.transport === "webrtc") {
    if (session.meta.codecId !== "h264") {
      session.close();
      routePlayback.close();
      throw new Error(
        `WebRTC transport currently supports only H.264, but scrcpy selected ${session.meta.codecId}.`,
      );
    }
    try {
      webRtcPublisher = await createWebRtcPublisher({
        settings: streamSettings,
        onKeyframeRequest: requestVideoReset,
      });
    } catch (err) {
      session.close();
      routePlayback.close();
      throw err;
    }
  }

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        totalDroppedFrames++;
        return;
      }
      client.awaitingKeyFrame = false;
    }

    const buffered = client.socket.bufferedAmount;
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      console.warn(
        `client ${client.id} too slow: closing (buffered ${buffered} B > ${CLOSE_CLIENT_BUFFERED_BYTES} B, ${client.droppedFrames} dropped)`,
      );
      clients.delete(client);
      try {
        client.socket.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    client.socket.send(data);
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  (async () => {
    try {
      while (!stopRequested) {
        const f = await session.readFrame();
        if (!f) {
          if (!stopRequested) markTerminal("error", "scrcpy video stream ended");
          break;
        }
        if (f.type === "session") {
          // The encoder restarted with a new size (device rotation). Adopt it so
          // touch packets keep matching the video size (scrcpy drops touches
          // whose embedded screen size disagrees), and resync every client onto
          // the new stream from a fresh keyframe.
          if (f.width > 0 && f.height > 0) {
            screen.width = f.width;
            screen.height = f.height;
            cachedConfig = null;
            for (const c of clients) {
              if (!c.video) continue;
              c.awaitingKeyFrame = true;
              sendJson(c.socket, { type: "video-session", size: { width: f.width, height: f.height } });
            }
            webRtcPublisher?.resetVideoSource();
          }
          continue;
        }
        if (f.isConfig) {
          cachedConfig = f.data;
          configPacketCount++;
          continue;
        }
        frameCount++;
        lastFrameMs = Date.now();
        const config = f.isKey ? cachedConfig : null;
        webRtcPublisher?.sendFrame(f, config);
        let rawOut: Buffer | null = null;
        let framedOut: Buffer | null = null;
        for (const c of clients) {
          if (!c.video) continue;
          if (c.awaitingKeyFrame && !f.isKey) {
            c.droppedFrames++;
            totalDroppedFrames++;
            continue;
          }
          const out = c.frameMeta
            ? (framedOut ??= withFrameMeta(f.data, f, config))
            : (rawOut ??= withConfig(f.data, config));
          sendFrame(c, out, f.isKey);
        }
      }
    } catch (err) {
      if (!stopRequested) markTerminal("error", String(err));
    }
  })();

  watchdog = setInterval(() => {
    sourceFps = frameCount - lastFpsFrameCount;
    lastFpsFrameCount = frameCount;
  }, 1000);

  session.proc.once("exit", (code, signal) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
    }
  });
  session.controlSocket.once("error", (err) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy control socket error: ${err.message}`);
    }
  });

  const webRtcCorsHeaders = (req: Request) => corsHeadersForRequest(req, opts);
  const webRtcJsonHeaders = (req: Request) => ({
    ...webRtcCorsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
  });
  const webRtcForbiddenOrigin = (req: Request) =>
    Response.json(
      { error: "forbidden_origin", message: "Request origin is not allowed for WebRTC signaling." },
      { status: 403, headers: webRtcJsonHeaders(req) },
    );

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/api") {
      return Response.json(
        {
          generation: 0,
          serial: opts.serial,
          device: session.meta.deviceName,
          codec: session.meta.codecId,
          size: { width: screen.width, height: screen.height },
          status,
          lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
          lastError,
          clients: clients.size,
          stream: streamSettings,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({
          ok: true,
          currentSerial: opts.serial,
          devices: (await listAllDevices()).map((device) => ({
            ...device,
            current: device.serial === opts.serial,
          })),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/health") {
      return Response.json(health(), { status: status === "streaming" ? 200 : 503 });
    }

    if (url.pathname === "/webrtc/offer") {
      if (!isAllowedBrowserOrigin(req, opts)) return webRtcForbiddenOrigin(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: webRtcCorsHeaders(req) });
      try {
        if (streamSettings.transport !== "webrtc" || !webRtcPublisher) {
          throw new WebRtcSignalingError(
            "WebRTC transport is not enabled. Start serve-emu with --transport webrtc.",
            400,
            "webrtc_not_enabled",
          );
        }
        if (!isJsonRequest(req)) {
          throw new WebRtcSignalingError(
            "WebRTC offers require application/json",
            415,
            "unsupported_media_type",
          );
        }
        const offer = parseWebRtcOffer(
          parseJsonBody(await readBodyText(req, MAX_WEBRTC_SIGNALING_BODY_BYTES), "invalid_offer"),
        );
        const answer = await webRtcPublisher.handleOffer(offer);
        if (req.signal.aborted) {
          webRtcPublisher.closeSession(offer.sessionId);
          return new Response(null, { status: 499, headers: webRtcCorsHeaders(req) });
        }
        return Response.json(answer, { headers: webRtcJsonHeaders(req) });
      } catch (err) {
        const status = err instanceof WebRtcSignalingError ? err.status : 500;
        const code = err instanceof WebRtcSignalingError ? err.code : "webrtc_offer_failed";
        return Response.json(
          { error: code, message: errMsg(err) },
          { status, headers: webRtcJsonHeaders(req) },
        );
      }
    }

    if (url.pathname === "/webrtc/close") {
      if (!isAllowedBrowserOrigin(req, opts)) return webRtcForbiddenOrigin(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: webRtcCorsHeaders(req) });
      try {
        const request = parseWebRtcCloseRequest(
          parseJsonBody(await readBodyText(req, MAX_WEBRTC_CLOSE_BODY_BYTES), "invalid_close_request"),
        );
        webRtcPublisher?.closeSession(request.sessionId);
        return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      } catch (err) {
        const status = err instanceof WebRtcSignalingError ? err.status : 400;
        const code = err instanceof WebRtcSignalingError ? err.code : "invalid_close_request";
        return Response.json(
          { error: code, message: errMsg(err) },
          { status, headers: webRtcJsonHeaders(req) },
        );
      }
    }

    if (url.pathname === "/api/logcat") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (!isAllowedBrowserOrigin(req, opts)) {
        return Response.json({ error: "forbidden_origin" }, { status: 403 });
      }
      return logcatStream(req, url);
    }

    if (url.pathname === "/api/screenshot") {
      if (req.method !== "GET" && req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const png = await screencapPng(opts.serial);
        if (url.searchParams.get("format") === "base64") {
          return Response.json({
            ok: true,
            mimeType: "image/png",
            data: png.toString("base64"),
          });
        }
        return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/foreground") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({
          ok: true,
          app: await getForegroundApp(opts.serial),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/accessibility") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json(await getAccessibilitySnapshot(opts.serial));
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/uimode") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, night: getNightMode(opts.serial) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "POST") {
        try {
          const payload = await readJsonBody(req);
          const night =
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>).night
              : undefined;
          if (!isNightMode(night)) {
            throw new Error('night must be one of "yes", "no", or "auto"');
          }
          return Response.json({ ok: true, night: setNightMode(opts.serial, night) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/tap") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "tap", "rest:tap");
    }

    if (url.pathname === "/api/swipe") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "swipe", "rest:swipe");
    }

    if (url.pathname === "/api/text") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "text", "rest:text");
    }

    if (url.pathname === "/api/key") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return keyEndpoint(req);
    }

    if (url.pathname === "/api/orientation") {
      if (req.method === "GET") {
        try {
          return Response.json({
            ok: true,
            orientation: await getUserRotation(opts.serial),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "POST") {
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("orientation payload must be an object");
          }
          const orientation = (payload as Record<string, unknown>).orientation;
          if (orientation !== "auto" && orientation !== "portrait" && orientation !== "landscape") {
            throw new Error("orientation must be auto, portrait, or landscape");
          }
          return Response.json({
            ok: true,
            orientation: await setUserRotation(
              opts.serial,
              orientation as OrientationMode,
            ),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/session") {
      if (req.method === "GET") return Response.json(sessionRecorder.snapshot());
      if (req.method === "DELETE") return Response.json({ ok: true, session: sessionRecorder.clear() });
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/session/replay") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        const multiplier =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? Number((payload as Record<string, unknown>).multiplier ?? 1)
            : 1;
        const replay = sessionRecorder.replay(
          {
            dispatchGesture: (gesture) => dispatchGesture(gesture, "session:replay", false),
            setLocation: async (fix) => {
              await applyLocation(fix, "session:replay", false);
            },
          },
          multiplier,
        );
        void replay.catch(() => {});
        return Response.json({ ok: true, session: sessionRecorder.snapshot() });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/session/replay/stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return Response.json({ ok: true, session: sessionRecorder.stopReplay() });
    }

    if (url.pathname === "/api/apps/install") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return installEndpoint(req);
    }

    if (url.pathname === "/api/files/import") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return fileImportEndpoint(req);
    }

    if (url.pathname === "/api/apps/launch") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        launchApp(
          opts.serial,
          String(payload.packageName ?? ""),
          typeof payload.activity === "string" && payload.activity.trim()
            ? payload.activity
            : undefined,
        ),
      );
    }

    if (url.pathname === "/api/apps/clear") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        clearAppData(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/force-stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        forceStopApp(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/grant") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        grantPermission(
          opts.serial,
          String(payload.packageName ?? ""),
          String(payload.permission ?? ""),
        ),
      );
    }

    if (url.pathname === "/api/location") {
      if (req.method === "GET") {
        return Response.json({
          serial: opts.serial,
          emulator: /^emulator-\d+$/.test(opts.serial),
          location: lastLocation,
        });
      }
      if (req.method === "POST") {
        try {
          const fix = parseGeoFix(await readJsonBody(req));
          lastLocation = await applyLocation(fix, "rest:location");
          return Response.json({ ok: true, location: lastLocation });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route") {
      if (req.method === "GET") {
        return Response.json(routePlayback.snapshot());
      }
      if (req.method === "POST") {
        try {
          const route = parseRoutePlaybackRequest(await readJsonBody(req, MAX_ROUTE_BODY_BYTES));
          return Response.json({ ok: true, route: await routePlayback.start(route) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "DELETE") {
        return Response.json({ ok: true, route: routePlayback.stop() });
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route/control") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("control payload must be an object");
        }
        const action = (payload as Record<string, unknown>).action;
        if (action === "pause") return Response.json({ ok: true, route: routePlayback.pause() });
        if (action === "resume") return Response.json({ ok: true, route: routePlayback.resume() });
        if (action === "stop") return Response.json({ ok: true, route: routePlayback.stop() });
        throw new Error("action must be pause, resume, or stop");
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
  };

  /**
   * Register a freshly-connected video/gesture client. The caller owns the
   * transport upgrade and passes a {@link StreamSocket} plus the `frame-meta`
   * flag (whether to prefix each frame with the SEMU metadata header). WebRTC
   * viewers can attach a `video=false` socket for low-latency input only.
   */
  const attachWebSocket = (socket: StreamSocket, meta: { frameMeta: boolean; video?: boolean }): void => {
    if (status !== "streaming") {
      socket.close(1013, `session is ${status}`);
      return;
    }
    const client: Client = {
      id: nextClientId++,
      socket,
      video: meta.video ?? true,
      frameMeta: meta.frameMeta,
      sentFrames: 0,
      droppedFrames: 0,
      backpressureEvents: 0,
      awaitingKeyFrame: true,
    };
    clients.add(client);
    if (client.video) requestVideoReset("client opened");

    socket.onMessage((raw) => {
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        socket.close(1009, "message too large");
        return;
      }
      try {
        if (status !== "streaming") throw new Error(`session is ${status}`);
        const payload = JSON.parse(raw);
        const acknowledge = wantsAck(payload);
        if (isResetVideoRequest(payload)) {
          requestVideoReset("client requested keyframe");
          if (acknowledge) sendJson(socket, { ok: true });
          return;
        }
        const msg = parseGesture(payload);
        void dispatchGesture(msg, "ws", shouldRecord(payload))
          .then(() => {
            if (acknowledge) sendJson(socket, { ok: true });
          })
          .catch((err) => sendJson(socket, { ok: false, error: String(err) }));
      } catch (err) {
        sendJson(socket, { ok: false, error: String(err) });
      }
    });

    socket.onClose(() => {
      clients.delete(client);
    });
  };

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    webRtcPublisher?.close();
    if (watchdog) clearInterval(watchdog);
    if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
    pendingVideoResetTimer = null;
    pendingVideoResetReason = null;
    routePlayback.close();
    void uploader.close(new Error("server stopping"));
    session.close();
  };

  return {
    session,
    isStreaming: () => status === "streaming",
    health,
    handleRequest,
    attachWebSocket,
    stop,
  };
}

export type EmuApp = Awaited<ReturnType<typeof createApp>>;

export type RouterDefaults = Partial<AppOptions>;

export type RouterDependencies = {
  listDevices?: typeof listDevices;
  listAllDevices?: typeof listAllDevices;
  listAvds?: typeof listAvds;
  listRunningAvds?: typeof listRunningAvds;
  resolveRunningAvds?: typeof resolveRunningAvds;
  startEmulator?: typeof startEmulator;
  stopEmulator?: typeof stopEmulator;
  createApp?: (opts: AppOptions) => Promise<EmuApp>;
};

/**
 * Multi-device router. Owns a lazily-populated `Map<serial, EmuApp>` and routes
 * each request to the app for its `?device=<serial>` query (falling back to the
 * first available device when absent). The UI shell and the `/api/devices`
 * fleet listing are served without requiring any device. Both `server.ts` (Bun)
 * and the Expo DevTools plugin mount this onto their own transport, so the
 * device-routing logic lives here once rather than in each transport.
 */
export function createRouter(
  defaults: RouterDefaults = {},
  dependencies: RouterDependencies = {},
) {
  const readOnlineDevices = dependencies.listDevices ?? listDevices;
  const readAllDevices = dependencies.listAllDevices ?? listAllDevices;
  const readAvds = dependencies.listAvds ?? listAvds;
  const readRunningAvds = dependencies.listRunningAvds ?? listRunningAvds;
  const resolveAvds = dependencies.resolveRunningAvds ?? resolveRunningAvds;
  const launchEmulator = dependencies.startEmulator ?? startEmulator;
  const killEmulator = dependencies.stopEmulator ?? stopEmulator;
  const createDeviceApp = dependencies.createApp ?? createApp;
  const apps = new Map<string, EmuApp>();
  const pending = new Map<string, Promise<EmuApp>>();
  const failureAt = new Map<string, number>();
  const stoppingSerials = new Set<string>();
  let selectedSerial = defaults.serial ?? null;
  let selectionRevision = 0;

  // Resolve the serial a request targets: an explicit (connected) `?device=`,
  // else the configured default if still attached, else the first online
  // device. Throws only when *no* device is attached — multiple devices is
  // never an error (we just take the first), so the UI always opens cleanly.
  const resolveSerial = async (
    requested?: string | null,
  ): Promise<string> => {
    const discovered = await readOnlineDevices();
    for (const serial of stoppingSerials) {
      if (!discovered.some((device) => device.serial === serial)) {
        stoppingSerials.delete(serial);
      }
    }
    const online = discovered.filter(
      (device) => !stoppingSerials.has(device.serial),
    );
    if (requested) {
      if (!online.some((d) => d.serial === requested)) {
        throw new Error(`device ${requested} is not connected`);
      }
      return requested;
    }
    if (
      selectedSerial &&
      online.some((device) => device.serial === selectedSerial)
    ) {
      return selectedSerial;
    }
    const first = online[0];
    if (!first) {
      throw new Error("No booted Android device found. Start an emulator or attach a device.");
    }
    selectedSerial = first.serial;
    return first.serial;
  };

  // Get (or lazily start) the app for a serial. A dead session is torn down so
  // the next call re-initializes; repeated start failures are throttled.
  const getApp = (serial: string): Promise<EmuApp> => {
    const existing = apps.get(serial);
    if (existing) {
      if (existing.isStreaming()) return Promise.resolve(existing);
      try {
        existing.stop();
      } catch {}
      apps.delete(serial);
    }
    const inFlight = pending.get(serial);
    if (inFlight) return inFlight;
    if (Date.now() - (failureAt.get(serial) ?? 0) < SPAWN_RETRY_COOLDOWN_MS) {
      return Promise.reject(
        new Error(`serve-emu start for ${serial} is cooling down after a failure`),
      );
    }
    const promise = (async () => {
      const created = await createDeviceApp({ ...defaults, serial });
      apps.set(serial, created);
      return created;
    })();
    pending.set(serial, promise);
    promise.then(
      () => pending.delete(serial),
      () => {
        pending.delete(serial);
        failureAt.set(serial, Date.now());
      },
    );
    return promise;
  };

  // Resolve + start in one step.
  const ensure = async (requested?: string | null): Promise<{ serial: string; app: EmuApp }> => {
    const serial = await resolveSerial(requested);
    return { serial, app: await getApp(serial) };
  };

  const devicesResponse = async (): Promise<Response> => {
    let defaultSerial: string | null = null;
    try {
      defaultSerial = await resolveSerial(null);
    } catch {
      defaultSerial = null;
    }
    return Response.json({
      ok: true,
      defaultSerial,
      devices: (await readAllDevices()).map((device) => ({
        ...device,
        streaming: apps.get(device.serial)?.isStreaming() ?? false,
      })),
    });
  };

  const readRouterPayload = async (req: Request): Promise<Record<string, unknown>> => {
    const payload = await readJsonLimited(req, MAX_JSON_BODY_BYTES);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("payload must be an object");
    }
    return payload as Record<string, unknown>;
  };

  const selectSerial = async (serial: string): Promise<EmuApp> => {
    const revision = ++selectionRevision;
    const resolved = await resolveSerial(serial);
    const app = await getApp(resolved);
    if (revision !== selectionRevision) {
      throw new Error("device selection was superseded");
    }
    selectedSerial = resolved;
    return app;
  };

  const stopApp = async (serial: string): Promise<void> => {
    const inFlight = pending.get(serial);
    let stoppedInFlight: EmuApp | null = null;
    if (inFlight) {
      stoppedInFlight = await inFlight.catch(() => null);
      try {
        stoppedInFlight?.stop();
      } catch {}
    }
    const app = apps.get(serial);
    if (app && app !== stoppedInFlight) {
      try {
        app.stop();
      } catch {}
    }
    apps.delete(serial);
    failureAt.delete(serial);
  };

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Fleet endpoint — lists every adb device, so it is not device-scoped.
    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return await devicesResponse();
      } catch (err) {
        return Response.json({ ok: false, error: errMsg(err) }, { status: 400 });
      }
    }

    if (url.pathname === "/api/device-grid") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      let currentSerial = "";
      try {
        currentSerial = await resolveSerial(null);
      } catch {}
      const currentStatus = currentSerial
        ? (apps.get(currentSerial)?.health().status ?? "streaming")
        : "stopped";
      try {
        return Response.json(
          await loadDeviceGrid(currentSerial, currentStatus, {
            listAllDevices: () => readAllDevices(),
            listAvds: () => readAvds(),
            resolveRunningAvds: (devices) => resolveAvds(devices),
          }),
        );
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/devices/select") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        const serial =
          typeof payload.serial === "string" ? payload.serial.trim() : "";
        if (!serial) throw new Error("serial is required");
        const app = await selectSerial(serial);
        return Response.json({
          ok: true,
          serial,
          device: app.session.meta.deviceName,
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/avds/start") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        const avd = typeof payload.avd === "string" ? payload.avd.trim() : "";
        if (!avd) throw new Error("avd is required");
        const launch = await launchEmulator({ avd });
        stoppingSerials.delete(launch.serial);
        const select = payload.select !== false;
        if (!select) {
          return Response.json({ ok: true, serial: launch.serial, avd });
        }
        try {
          const app = await selectSerial(launch.serial);
          return Response.json({
            ok: true,
            serial: launch.serial,
            avd,
            device: app.session.meta.deviceName,
          });
        } catch (err) {
          launch.stop();
          throw err;
        }
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/avds/stop") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        let serial =
          typeof payload.serial === "string" ? payload.serial.trim() : "";
        const avd =
          typeof payload.avd === "string" ? payload.avd.trim() : "";
        if (!serial && avd) {
          const running = await readRunningAvds();
          serial =
            running.find((candidate) => candidate.avd === avd)?.serial ?? "";
        }
        if (!serial) throw new Error("serial or running avd is required");
        if (!/^emulator-\d+$/.test(serial)) {
          throw new Error(`${serial} is not an emulator`);
        }
        stoppingSerials.add(serial);
        await stopApp(serial);
        try {
          await killEmulator(serial);
        } catch (err) {
          stoppingSerials.delete(serial);
          throw err;
        }
        if (selectedSerial === serial) {
          selectionRevision++;
          selectedSerial = null;
        }
        return Response.json({ ok: true, serial });
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    // Device-scoped endpoints are `/api`, `/api/*` (other than the fleet listing
    // handled above), and `/health`. Everything else is the device-independent
    // UI shell — serve it (and its 404s) without starting a device, so the page
    // loads before one is selected or attached.
    const deviceScoped =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/health" ||
      url.pathname === "/webrtc/offer" ||
      url.pathname === "/webrtc/close";
    if (!deviceScoped) {
      return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
    }

    // Everything else operates on a single device.
    let app: EmuApp;
    try {
      app = (await ensure(url.searchParams.get("device"))).app;
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 503 });
    }
    return app.handleRequest(req);
  };

  // Attach a video/gesture socket to an already-resolved, already-started
  // device. The transport ensures the serial before upgrading and passes it
  // here, so the app should exist; close defensively if it raced away.
  const attachWebSocket = (
    socket: StreamSocket,
    opts: { serial: string; frameMeta: boolean; video?: boolean },
  ): void => {
    const app = apps.get(opts.serial);
    if (!app) {
      socket.close(1011, "device not ready");
      return;
    }
    app.attachWebSocket(socket, { frameMeta: opts.frameMeta, video: opts.video });
  };

  const stopAll = () => {
    for (const app of apps.values()) {
      try {
        app.stop();
      } catch {}
    }
    apps.clear();
  };

  return {
    resolveSerial,
    getApp,
    ensure,
    handleRequest,
    attachWebSocket,
    stopAll,
  };
}

export type EmuRouter = ReturnType<typeof createRouter>;
