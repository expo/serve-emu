import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { execText } from "./exec.ts";
import {
  getFontScale,
  getNetworkStatus,
  getNightMode,
  getUserRotation,
  listAllDevices,
  screencapPng,
  setFontScale,
  setNetworkEnabled,
  setNightMode,
  setUserRotation,
} from "./adb.ts";
import {
  findAccessibilityNode,
  getAccessibilitySnapshot,
  type AccessibilitySelector,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  importMediaFile,
  installApk,
  launchApp,
} from "./app-management.ts";
import { getForegroundApp } from "./app-info.ts";
import { FrameStatWindow } from "./frame-stat-window.ts";
import {
  isAbnormalExit,
  procExitDetail,
  terminalTransitionAllowed,
  type SessionStatus,
} from "./session-status.ts";
import {
  FRAME_META_HEADER_BYTES,
  epochNowMs,
  writeFrameMetaHeader,
} from "./shared/frame-meta.ts";
import type {
  DeviceGridResponse,
  GridDevice,
  HealthResponse,
  LogcatEventMap,
} from "./shared/api-contracts.ts";
import {
  parseWsClientJson,
  type WsServerMessage,
} from "./shared/websocket-contracts.ts";
import {
  startScrcpy,
  type ScrcpySession,
  ScrcpyStreamError,
} from "./scrcpy.ts";
import {
  listAvds,
  listRunningAvds,
  startEmulator,
  stopEmulator,
} from "./emulator.ts";
import {
  dispatch,
  resetVideoPacket,
  type Gesture,
  type Screen,
} from "./input.ts";
import {
  setEmulatorLocationAsync,
  type GeoFix,
} from "./location.ts";
import { RoutePlayback } from "./route-playback.ts";
import { SessionRecorder } from "./session-recorder.ts";
import { ApiError, apiErrorResponse } from "./api/api-error.ts";
import { createApiRouter } from "./api/router.ts";
import { createApiRoutes } from "./api/routes/index.ts";
import type { ApiDependencies } from "./api/dependencies.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  /** Address to bind. Defaults to loopback (127.0.0.1). */
  host?: string;
  /**
   * Shared secret required on every request. When empty/undefined, auth is
   * disabled (intended only for loopback binds). Presented via bearer token,
   * the `semu_session` cookie, or a `token` query param.
   */
  token?: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  repeatFrameMs?: number;
};

export const DEFAULT_HOST = "127.0.0.1";
const SESSION_COOKIE = "semu_session";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

type WsData = { id: number; frameMeta: boolean; handle?: Client };

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
// Rolling window used for /health frame timing stats: 240 frames ≈ 4s at 60fps.
const FRAME_STAT_WINDOW = 240;
const VIDEO_RESET_COOLDOWN_MS = 500;
const FIRST_FRAME_RESET_MS = 5000;
const AWAITING_KEYFRAME_RESET_MS = 2500;
const MAX_LOGCAT_QUERY_BYTES = 200;

export async function startServer(opts: ServerOpts) {
  const openScrcpy = (serial: string) =>
    startScrcpy({
      serial,
      maxFps: opts.maxFps,
      bitRate: opts.bitRate,
      maxSize: opts.maxSize,
      keyFrameInterval: opts.keyFrameInterval,
      repeatFrameMs: opts.repeatFrameMs,
    });

  const host = opts.host ?? DEFAULT_HOST;
  const authToken = opts.token && opts.token.length > 0 ? opts.token : null;

  /** Token presented by the request, from bearer header, cookie, or query. */
  const presentedToken = (req: Request, url: URL): string | null => {
    const authorization = req.headers.get("authorization");
    if (authorization && authorization.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length).trim();
    }
    const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    if (cookie) return cookie;
    return url.searchParams.get("token");
  };

  const tokenValid = (req: Request, url: URL): boolean => {
    if (!authToken) return true;
    const presented = presentedToken(req, url);
    return presented !== null && safeEqual(presented, authToken);
  };

  /**
   * Same-origin guard for state-changing requests and the WebSocket upgrade.
   * A missing Origin means a non-browser client (CLI/agent), which is gated by
   * the token check instead. A present Origin must match the request Host.
   */
  const originAllowed = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === req.headers.get("host");
  };

  let currentSerial = opts.serial;
  let session: ScrcpySession = await openScrcpy(currentSerial);
  console.log(
    `scrcpy ready: ${session.meta.deviceName} • ${session.meta.codecId} • ${session.meta.width}×${session.meta.height}`,
  );

  const clients = new Set<Client>();
  const screen: Screen = {
    width: session.meta.width,
    height: session.meta.height,
  };
  let startedMs = Date.now();
  let startedAt = new Date(startedMs).toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let lastErrorCode: string | null = null;
  let lastErrorMeta: Record<string, string | number> | null = null;
  // Terminal cleanup (session.close/closeClients) must run once per session, but
  // status may still escalate afterward (clean-eof "stopped" → crash "error").
  let terminalCleanupDone = false;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let frameCount = 0;
  let configPacketCount = 0;
  let lastFrameMs = 0;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  const frameStats = new FrameStatWindow(FRAME_STAT_WINDOW);
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastLocation: (GeoFix & { appliedAt: string }) | null = null;
  const createRoutePlayback = () =>
    new RoutePlayback({
      applyLocation: (fix) => setEmulatorLocationAsync(currentSerial, fix),
      onLocation: (fix) => {
        lastLocation = fix;
      },
    });
  let sessionRecorder = new SessionRecorder();
  let routePlayback = createRoutePlayback();
  let sessionGeneration = 0;
  let accessibilitySnapshotCache: {
    snapshot: AccessibilitySnapshot;
    expiresMs: number;
  } | null = null;
  let accessibilitySnapshotInFlight: Promise<AccessibilitySnapshot> | null =
    null;

  const health = (): HealthResponse => ({
    ok: status === "streaming",
    status,
    serial: currentSerial,
    device: session.meta.deviceName,
    codec: session.meta.codecId,
    size: { width: screen.width, height: screen.height },
    clients: clients.size,
    frames: frameCount,
    sourceFps,
    frameStats: frameStats.summary(),
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    location: lastLocation,
    route: routePlayback.snapshot(),
    session: sessionRecorder.snapshot(),
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.ws.getBufferedAmount(),
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
    lastError,
    lastErrorCode,
    lastErrorMeta,
  });

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.ws.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const deviceGrid = async (): Promise<DeviceGridResponse> => {
    const [adbDevices, runningAvds, avds] = await Promise.all([
      listAllDevices(),
      listRunningAvds(),
      listAvds(),
    ]);
    const runningBySerial = new Map(
      runningAvds.map((running) => [running.serial, running]),
    );
    const runningByAvd = new Map(
      runningAvds.map((running) => [running.avd, running]),
    );
    const rows: GridDevice[] = adbDevices.map((device) => {
      const running = runningBySerial.get(device.serial);
      const isEmulator = /^emulator-\d+$/.test(device.serial);
      return {
        id: device.serial,
        kind: isEmulator ? "emulator" : "physical",
        serial: device.serial,
        avd: running?.avd ?? null,
        name: running?.avd ?? device.serial,
        state: device.state,
        current: device.serial === currentSerial,
        canSelect: device.state === "device",
        canStart: false,
        canStop: isEmulator,
      };
    });

    const knownAvdSerials = new Set(
      runningAvds.map((running) => running.serial),
    );
    for (const avd of avds) {
      const running = runningByAvd.get(avd);
      if (running && knownAvdSerials.has(running.serial)) continue;
      rows.push({
        id: `avd:${avd}`,
        kind: "avd",
        serial: running?.serial ?? null,
        avd,
        name: avd,
        state: running?.state ?? "stopped",
        current: running?.serial === currentSerial,
        canSelect: running?.state === "device",
        canStart: !running,
        canStop: Boolean(running),
      });
    }

    return { ok: true, currentSerial, sessionStatus: status, devices: rows };
  };

  const markTerminal = (
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    generation = sessionGeneration,
    detail?: { code?: string; meta?: Record<string, string | number> | null },
  ) => {
    if (generation !== sessionGeneration) return;
    if (!terminalTransitionAllowed(status, nextStatus)) return;
    status = nextStatus;
    lastError = reason;
    lastErrorCode = detail?.code ?? null;
    lastErrorMeta = detail?.meta ?? null;
    stoppedAt = new Date().toISOString();
    if (!terminalCleanupDone) {
      terminalCleanupDone = true;
      if (watchdog) clearInterval(watchdog);
      routePlayback.close();
      session.close();
      closeClients(nextStatus === "error" ? 1011 : 1000, reason);
    }
  };

  const sendJson = (
    ws: ServerWebSocket<WsData>,
    value: WsServerMessage,
  ) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(
      FRAME_META_HEADER_BYTES + configBytes + frameData.length,
    );
    writeFrameMetaHeader(out, {
      isKey: frame.isKey,
      pts: frame.pts,
      serverTsMs: epochNowMs(),
    });
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

  const readAccessibilitySnapshot = async (cacheMs = 2_500) => {
    const now = Date.now();
    if (
      accessibilitySnapshotCache &&
      accessibilitySnapshotCache.expiresMs > now
    ) {
      return accessibilitySnapshotCache.snapshot;
    }
    if (accessibilitySnapshotInFlight) return accessibilitySnapshotInFlight;
    accessibilitySnapshotInFlight = getAccessibilitySnapshot(currentSerial)
      .then((snapshot) => {
        accessibilitySnapshotCache = {
          snapshot,
          expiresMs: Date.now() + cacheMs,
        };
        return snapshot;
      })
      .finally(() => {
        accessibilitySnapshotInFlight = null;
      });
    return accessibilitySnapshotInFlight;
  };

  const dispatchGesture = async (
    gesture: Gesture,
    source: string,
    record = true,
  ) => {
    if (status !== "streaming") {
      throw new ApiError(
        503,
        "service_unavailable",
        `session is ${status}`,
      );
    }
    await dispatch(session.controlSocket, gesture, screen);
    if (record) sessionRecorder.recordGesture(gesture, source);
  };

  const applyLocation = async (fix: GeoFix, source: string, record = true) => {
    routePlayback.stop();
    await setEmulatorLocationAsync(currentSerial, fix);
    lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (record) sessionRecorder.recordLocation(fix, source);
    return lastLocation;
  };

  const resolvePackagePids = async (
    packageName: string,
  ): Promise<Set<string>> => {
    if (!/^[A-Za-z0-9_.:-]+$/.test(packageName)) return new Set();
    const r = await execText(
      "adb",
      ["-s", currentSerial, "shell", "pidof", packageName],
      {
        timeout: 2_000,
      },
    );
    if (r.status !== 0) return new Set();
    return new Set(r.stdout.trim().split(/\s+/).filter(Boolean));
  };

  const logcatStream = (url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES)
      .toLowerCase();
    const proc = spawn("adb", [
      "-s",
      currentSerial,
      "logcat",
      "-v",
      "threadtime",
    ]);
    const encoder = new TextEncoder();
    let pidSet = new Set<string>();
    let pidTimer: ReturnType<typeof setInterval> | null = null;
    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = <Event extends keyof LogcatEventMap>(
          event: Event,
          value: LogcatEventMap[Event],
        ) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
              ),
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
            if (line && matches(line))
              send("log", { line, at: new Date().toISOString() });
          }
        };

        send("ready", {
          serial: currentSerial,
          package: packageName || null,
          pids: Array.from(pidSet),
          search: search || null,
        });
        if (packageName) {
          void resolvePackagePids(packageName).then((set) => {
            pidSet = set;
          });
          pidTimer = setInterval(() => {
            void resolvePackagePids(packageName).then((set) => {
              pidSet = set;
            });
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
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  const tapAccessibility = async (
    selector: AccessibilitySelector,
    record: boolean,
  ) => {
    const snapshot = await readAccessibilitySnapshot(1_000);
    let node;
    try {
      node = findAccessibilityNode(snapshot.nodes, selector);
    } catch (error) {
      throw new ApiError(
        404,
        "not_found",
        error instanceof Error ? error.message : "accessibility node not found",
        { cause: error },
      );
    }
    const centerX = (node.bounds.left + node.bounds.right) / 2;
    const centerY = (node.bounds.top + node.bounds.bottom) / 2;
    const accessibilityWidth = Math.max(
      ...snapshot.nodes.map((candidate) => candidate.bounds.right),
      screen.width,
    );
    const accessibilityHeight = Math.max(
      ...snapshot.nodes.map((candidate) => candidate.bounds.bottom),
      screen.height,
    );
    const x = centerX / accessibilityWidth;
    const y = centerY / accessibilityHeight;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1
    ) {
      throw new ApiError(
        409,
        "conflict",
        "matched accessibility node is outside the current stream bounds",
      );
    }
    await dispatchGesture({ type: "tap", x, y }, "accessibility:tap", record);
    return { ok: true as const, node, capturedAt: snapshot.capturedAt };
  };

  const requestVideoReset = (reason: string) => {
    const now = Date.now();
    if (now - lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS) return;
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      session.controlSocket.write(resetVideoPacket());
    } catch {}
  };

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

    const buffered = client.ws.getBufferedAmount();
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      dropUntilKeyFrame(client);
      return;
    }
    const sent = client.ws.send(data);
    if (sent === -1) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sent === 0) {
      clients.delete(client);
      return;
    }
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  const startFramePump = (activeSession: ScrcpySession, generation: number) => {
    cachedConfig = null;
    void (async () => {
      try {
        while (!stopRequested && generation === sessionGeneration) {
          const f = await activeSession.readFrame();
          if (generation !== sessionGeneration) break;
          if (!f) {
            if (!stopRequested)
              markTerminal("stopped", "scrcpy video stream ended", generation);
            break;
          }
          if (f.type === "session") {
            if (f.width > 0 && f.height > 0) {
              screen.width = f.width;
              screen.height = f.height;
              cachedConfig = null;
              for (const c of clients) {
                c.awaitingKeyFrame = true;
                sendJson(c.ws, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
              requestVideoReset(
                `video session resized to ${f.width}×${f.height}`,
              );
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
          frameStats.record(f.data.length, f.isKey);
          const config = f.isKey ? cachedConfig : null;
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of clients) {
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
        if (stopRequested) return;
        if (err instanceof ScrcpyStreamError) {
          markTerminal("error", err.message, generation, {
            code: err.code,
            meta: err.meta ?? null,
          });
        } else {
          markTerminal("error", String(err), generation);
        }
      }
    })();
  };

  const attachSessionHandlers = (
    activeSession: ScrcpySession,
    generation: number,
  ) => {
    activeSession.proc.once("exit", (code, signal) => {
      // An abnormal exit (non-zero code or killed by signal) means scrcpy died
      // unexpectedly — classify it as "error" even if the video socket already
      // ended cleanly and marked the session "stopped" (markTerminal escalates).
      // Normal exits and server-initiated teardowns (stopRequested / a bumped
      // generation) are left alone.
      if (stopRequested) return;
      if (!isAbnormalExit(code, signal)) return;
      const { reason, ...detail } = procExitDetail(code, signal);
      markTerminal("error", reason, generation, detail);
    });
    activeSession.controlSocket.once("error", (err) => {
      if (!stopRequested && status === "streaming") {
        markTerminal(
          "error",
          `scrcpy control socket error: ${err.message}`,
          generation,
        );
      }
    });
  };

  const resetSessionStats = (nextSession: ScrcpySession) => {
    screen.width = nextSession.meta.width;
    screen.height = nextSession.meta.height;
    startedMs = Date.now();
    startedAt = new Date(startedMs).toISOString();
    status = "streaming";
    lastError = null;
    lastErrorCode = null;
    lastErrorMeta = null;
    terminalCleanupDone = false;
    stoppedAt = null;
    frameCount = 0;
    configPacketCount = 0;
    lastFrameMs = 0;
    totalDroppedFrames = 0;
    totalBackpressureEvents = 0;
    sourceFps = 0;
    lastFpsFrameCount = 0;
    frameStats.reset();
    videoResetRequests = 0;
    lastVideoResetAt = null;
    lastVideoResetReason = null;
    lastVideoResetMs = 0;
    lastLocation = null;
    sessionRecorder = new SessionRecorder();
    routePlayback.close();
    routePlayback = createRoutePlayback();
    accessibilitySnapshotCache = null;
    accessibilitySnapshotInFlight = null;
  };

  const switchSession = async (serial: string) => {
    if (serial === currentSerial && status === "streaming") {
      return {
        ok: true as const,
        serial: currentSerial,
        device: session.meta.deviceName,
      };
    }
    const device = (await listAllDevices()).find(
      (candidate) => candidate.serial === serial,
    );
    if (!device) {
      throw new ApiError(404, "not_found", `Unknown adb device "${serial}".`);
    }
    if (device.state !== "device") {
      throw new ApiError(
        409,
        "conflict",
        `${serial} is ${device.state}, not ready.`,
      );
    }

    const nextSession = await openScrcpy(serial);
    const previousSession = session;
    sessionGeneration++;
    closeClients(1012, "device switched");
    try {
      previousSession.close();
    } catch {}
    currentSerial = serial;
    session = nextSession;
    resetSessionStats(nextSession);
    startFramePump(nextSession, sessionGeneration);
    attachSessionHandlers(nextSession, sessionGeneration);
    console.log(
      `scrcpy ready: ${nextSession.meta.deviceName} • ${nextSession.meta.codecId} • ${nextSession.meta.width}×${nextSession.meta.height}`,
    );
    return {
      ok: true as const,
      serial: currentSerial,
      device: nextSession.meta.deviceName,
    };
  };

  const stopCurrentSession = (reason: string) => {
    sessionGeneration++;
    status = "stopped";
    lastError = reason;
    stoppedAt = new Date().toISOString();
    routePlayback.close();
    closeClients(1000, reason);
    try {
      session.close();
    } catch {}
  };

  startFramePump(session, sessionGeneration);

  watchdog = setInterval(() => {
    sourceFps = frameCount - lastFpsFrameCount;
    lastFpsFrameCount = frameCount;
    if (status !== "streaming" || clients.size === 0) return;
    const now = Date.now();
    if (frameCount === 0 && now - startedMs > FIRST_FRAME_RESET_MS) {
      requestVideoReset("first video frame not received");
      return;
    }
    if (
      Array.from(clients).some((client) => client.awaitingKeyFrame) &&
      now - (lastFrameMs || startedMs) > AWAITING_KEYFRAME_RESET_MS
    ) {
      requestVideoReset("client awaiting keyframe");
    }
  }, 1000);

  attachSessionHandlers(session, sessionGeneration);

  const apiRouter = createApiRouter(createApiRoutes());
  const apiDependencies: ApiDependencies = {
    getInfo: () => ({
      serial: currentSerial,
      device: session.meta.deviceName,
      codec: session.meta.codecId,
      size: { width: screen.width, height: screen.height },
      status,
      clients: clients.size,
    }),
    listDevices: async () => ({
      ok: true,
      currentSerial,
      devices: (await listAllDevices()).map((device) => ({
        ...device,
        current: device.serial === currentSerial,
      })),
    }),
    getDeviceGrid: deviceGrid,
    selectDevice: switchSession,
    startAvd: async (avd, select) => {
      const avdName = avd.startsWith("@") ? avd.slice(1) : avd;
      if (!(await listAvds()).includes(avdName)) {
        throw new ApiError(404, "not_found", `Unknown AVD "${avd}".`);
      }
      const launch = await startEmulator({ avd });
      if (select) {
        const switched = await switchSession(launch.serial);
        return { ...switched, avd };
      }
      return { ok: true, serial: launch.serial, avd };
    },
    stopAvd: async ({ serial: requestedSerial, avd }) => {
      let serial = requestedSerial ?? "";
      if (!serial && avd) {
        serial = (await listRunningAvds()).find(
          (running) => running.avd === avd,
        )?.serial ?? "";
      }
      if (!serial) {
        throw new ApiError(404, "not_found", "running emulator was not found");
      }
      if (!(await listAllDevices()).some((device) => device.serial === serial)) {
        throw new ApiError(404, "not_found", `Unknown emulator "${serial}".`);
      }
      if (serial === currentSerial) {
        stopCurrentSession("current emulator stopped");
      }
      await stopEmulator(serial);
      return { ok: true, serial };
    },
    getOrientation: () => getUserRotation(currentSerial),
    setOrientation: (orientation) => setUserRotation(currentSerial, orientation),
    getNightMode: () => getNightMode(currentSerial),
    setNightMode: (mode) => setNightMode(currentSerial, mode),
    getFontScale: () => getFontScale(currentSerial),
    setFontScale: (scale) => setFontScale(currentSerial, scale),
    getNetwork: () => getNetworkStatus(currentSerial),
    setNetwork: (enabled) => setNetworkEnabled(currentSerial, enabled),
    openLogcat: logcatStream,
    takeScreenshot: () => screencapPng(currentSerial),
    getForegroundApp: () => getForegroundApp(currentSerial),
    getAccessibility: () => readAccessibilitySnapshot(),
    tapAccessibility,
    dispatchGesture,
    getSession: () => sessionRecorder.snapshot(),
    clearSession: () => sessionRecorder.clear(),
    replaySession: (multiplier) => {
      const snapshot = sessionRecorder.snapshot();
      if (snapshot.replaying) {
        throw new ApiError(
          409,
          "conflict",
          "session replay is already running",
        );
      }
      if (snapshot.events.length === 0) {
        throw new ApiError(409, "conflict", "session has no recorded events");
      }
      const replay = sessionRecorder.replay(
        {
          dispatchGesture: (gesture) =>
            dispatchGesture(gesture, "session:replay", false),
          setLocation: async (fix) => {
            await applyLocation(fix, "session:replay", false);
          },
        },
        multiplier,
      );
      void replay.catch(() => {});
      return sessionRecorder.snapshot();
    },
    stopSessionReplay: () => sessionRecorder.stopReplay(),
    installApk: (file) => installApk(currentSerial, file),
    importFile: (file) => importMediaFile(currentSerial, file),
    launchApp: (packageName, activity) =>
      launchApp(currentSerial, packageName, activity),
    clearApp: (packageName) => clearAppData(currentSerial, packageName),
    forceStopApp: (packageName) => forceStopApp(currentSerial, packageName),
    grantPermission: (packageName, permission) =>
      grantPermission(currentSerial, packageName, permission),
    getLocation: () => ({
      serial: currentSerial,
      emulator: /^emulator-\d+$/.test(currentSerial),
      location: lastLocation,
    }),
    setLocation: (fix) => {
      if (!/^emulator-\d+$/.test(currentSerial)) {
        throw new ApiError(
          409,
          "conflict",
          "location control requires an Android Emulator",
        );
      }
      return applyLocation(fix, "rest:location");
    },
    getRoute: () => routePlayback.snapshot(),
    startRoute: (route) => routePlayback.start(route),
    stopRoute: () => routePlayback.stop(),
    controlRoute: (action) => {
      if (action === "pause") return routePlayback.pause();
      if (action === "resume") return routePlayback.resume();
      return routePlayback.stop();
    },
  };

  let nextId = 1;
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: host,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // Bootstrap: exchange a valid one-time URL token for an HttpOnly cookie,
      // then redirect to a clean URL so the secret never lingers in the address
      // bar, browser history, or referer logs. Same-origin fetch/EventSource/WS
      // calls carry the cookie automatically afterward. Scoped to browser
      // navigations (Accept: text/html) so agents hitting `/api?token=` still
      // get their JSON response instead of a redirect.
      if (
        authToken &&
        req.method === "GET" &&
        (req.headers.get("accept") ?? "").includes("text/html")
      ) {
        const queryToken = url.searchParams.get("token");
        if (queryToken && safeEqual(queryToken, authToken)) {
          const clean = new URL(url);
          clean.searchParams.delete("token");
          return new Response(null, {
            status: 303,
            headers: {
              Location: `${clean.pathname}${clean.search}`,
              "Set-Cookie": `${SESSION_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
            },
          });
        }
      }

      if (!tokenValid(req, url)) {
        return apiErrorResponse(
          new ApiError(401, "unauthorized", "Unauthorized", {
            headers: { "WWW-Authenticate": "Bearer" },
          }),
        );
      }

      // CSRF / cross-origin guard: reject upgrades and state-changing requests
      // whose Origin does not match the host. Applied even without auth so the
      // control channel is never open to arbitrary cross-origin pages.
      if (
        url.pathname === "/ws" ||
        (req.method !== "GET" && req.method !== "HEAD")
      ) {
        if (!originAllowed(req)) {
          return apiErrorResponse(
            new ApiError(403, "forbidden", "Forbidden origin"),
          );
        }
      }

      if (url.pathname === "/health") {
        return Response.json(health(), {
          status: status === "streaming" ? 200 : 503,
        });
      }

      const apiResponse = await apiRouter.handle(req, apiDependencies);
      if (apiResponse) return apiResponse;

      if (url.pathname === "/ws") {
        if (status !== "streaming") {
          return new Response(JSON.stringify(health()), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { id: nextId++, frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (reqPath.includes(".."))
        return new Response("not found", { status: 404 });
      const file = Bun.file(join(UI_DIR, reqPath));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const handle: Client = {
          id: ws.data.id,
          ws,
          frameMeta: ws.data.frameMeta,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: true,
        };
        clients.add(handle);
        ws.data.handle = handle;
        requestVideoReset("client opened");
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        if (Buffer.byteLength(raw, "utf8") > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        try {
          if (status !== "streaming") throw new Error(`session is ${status}`);
          const message = parseWsClientJson(raw);
          const acknowledge = message.ack !== false;
          if (message.type === "reset-video") {
            requestVideoReset("client requested keyframe");
            if (acknowledge) sendJson(ws, { ok: true });
            return;
          }
          void dispatchGesture(message, "ws", message.record !== false)
            .then(() => {
              if (acknowledge) sendJson(ws, { ok: true });
            })
            .catch((err) => sendJson(ws, { ok: false, error: String(err) }));
        } catch (err) {
          sendJson(ws, { ok: false, error: String(err) });
        }
      },
      close(ws) {
        if (ws.data.handle) clients.delete(ws.data.handle);
      },
    },
  });

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    if (watchdog) clearInterval(watchdog);
    routePlayback.close();
    server.stop(true);
    session.close();
  };

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
