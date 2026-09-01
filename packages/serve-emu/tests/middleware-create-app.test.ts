import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import {
  createApp,
  type AppClock,
} from "../src/middleware.ts";
import type {
  ScrcpySession,
  VideoFrame,
} from "../src/scrcpy.ts";
import {
  adaptScrcpySession,
  type EmuSession,
  type GrpcCaptureDiagnostics,
} from "../src/stream-session.ts";
import type {
  WebRtcPublisher,
  WebRtcPublisherSessionStats,
} from "../src/webrtc-publisher.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const GRPC_CAPTURE_DIAGNOSTICS: GrpcCaptureDiagnostics = {
  rawGrpcMessagesReceived: 120,
  rawGrpcMessagesEmitted: 100,
  rawGrpcMessagesCoalesced: 20,
  usableImages: 98,
  sequenceGaps: 22,
  sourceTimestampIntervalMs: {
    windowSamples: 97,
    latest: 16.7,
    p50: 16.6,
    p95: 20.1,
    max: 25,
  },
  productionToReceiveLatencyMs: {
    windowSamples: 98,
    latest: 4.2,
    p50: 3.8,
    p95: 8.5,
    max: 12,
  },
  freshEncoderWriteAttempts: 96,
  repeatEncoderWriteAttempts: 2,
  acceptedEncoderWrites: 95,
  encoderBackpressureRejections: 3,
};

class ManualAppClock implements AppClock {
  #nowMs = 0;
  #callback: (() => void) | null = null;
  readonly #timer = Symbol("middleware interval");

  now(): number {
    return this.#nowMs;
  }

  setInterval(callback: () => void, intervalMs: number): unknown {
    expect(intervalMs).toBe(1_000);
    expect(this.#callback).toBeNull();
    this.#callback = callback;
    return this.#timer;
  }

  clearInterval(timer: unknown): void {
    expect(timer).toBe(this.#timer);
    this.#callback = null;
  }

  advance(elapsedMs: number): void {
    this.#nowMs += elapsedMs;
  }

  sampleAfter(elapsedMs: number): void {
    this.advance(elapsedMs);
    this.#callback?.();
  }
}

function fakeScrcpySession(
  frameTotal: number,
  beforeFrame?: () => void,
): {
  session: ScrcpySession;
  drained: Promise<void>;
} {
  const proc = new EventEmitter();
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): boolean;
  };
  controlSocket.write = () => true;

  let remainingFrames = frameTotal;
  let nextPts = 0n;
  let resolveDrained!: () => void;
  let resolveEnd!: (frame: null) => void;
  let reportedDrained = false;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const end = new Promise<null>((resolve) => {
    resolveEnd = resolve;
  });

  const session = {
    transport: "scrcpy",
    meta: {
      deviceName: "middleware-fps-test",
      codecId: "h264",
      width: 720,
      height: 1_280,
    },
    protocol: 3,
    videoReader: {},
    controlSocket,
    proc,
    scid: "00000001",
    localPort: 27_200,
    serial: "device-test",
    readFrame: (): Promise<VideoFrame | null> => {
      if (remainingFrames > 0) {
        remainingFrames--;
        beforeFrame?.();
        const frame: VideoFrame = {
          type: "frame",
          data: Buffer.from([0, 0, 0, 1, 1]),
          pts: nextPts++,
          isConfig: false,
          isKey: false,
        };
        return Promise.resolve(frame);
      }
      if (!reportedDrained) {
        reportedDrained = true;
        resolveDrained();
      }
      return end;
    },
    close: () => {
      resolveEnd(null);
    },
  } as unknown as ScrcpySession;

  return { session, drained };
}

function fakeWebRtcPublisher(): WebRtcPublisher {
  const stats: WebRtcPublisherSessionStats = {
    sessionId: SESSION_ID,
    state: "connected",
    iceState: "connected",
    connected: true,
    submittedFrames: 50,
    publisherDroppedFrames: 0,
    payloadBytesSubmitted: 250,
    localCandidateType: "host",
    remoteCandidateType: "host",
    localCandidateTransport: "udp",
    remoteCandidateTransport: "udp",
    path: "direct",
  };
  return {
    statsForSession: (sessionId?: string | null) =>
      sessionId === SESSION_ID ? [stats] : [],
    sendFrame: () => ({ accepted: true, awaitingKeyFrame: false }),
    snapshot: () => ({
      peers: 1,
      activePeers: 1,
      signalingPending: false,
      detail: [],
    }),
    resetVideoSource: () => {},
    close: () => {},
  } as unknown as WebRtcPublisher;
}

test("normalizes middleware source FPS by the actual elapsed time", async () => {
  const clock = new ManualAppClock();
  const { session, drained } = fakeScrcpySession(50);
  const app = await createApp(
    {
      serial: session.serial,
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await drained;
    expect(app.health().frames).toBe(50);

    clock.sampleAfter(0);
    clock.sampleAfter(2_500);

    const healthResponse = await app.handleRequest(
      new Request("http://middleware.test/health"),
    );
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toMatchObject({
      frames: 50,
      sourceFps: 20,
    });
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      source: { frames: 50, fps: 20 },
      capture: { offeredFrames: 50, forwardedFrames: 50 },
    });
  } finally {
    app.stop();
  }
});

test("uses the 60 FPS scrcpy default when middleware maxFps is omitted", async () => {
  const { session } = fakeScrcpySession(0);
  let openedMaxFps: number | undefined;
  const app = await createApp(
    { serial: session.serial },
    {
      startSession: async (options) => {
        openedMaxFps = options.maxFps;
        return adaptScrcpySession(session);
      },
    },
  );

  try {
    expect(openedMaxFps).toBe(60);
  } finally {
    app.stop();
  }
});

test("reports configured source settings and rolling encoded-frame timing", async () => {
  const clock = new ManualAppClock();
  const { session, drained } = fakeScrcpySession(3, () => clock.advance(20));
  const app = await createApp(
    {
      serial: session.serial,
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await drained;
    const frameStats = {
      windowFrames: 3,
      intervalMs: { p50: 20, p95: 20, max: 20 },
      avgKeyFrameBytes: null,
      avgDeltaFrameBytes: 5,
      keyFramesInWindow: 0,
    };
    expect(app.health()).toMatchObject({ frameStats });
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      source: {
        streamMode: "scrcpy",
        configuredFps: 60,
        frameStats,
      },
    });
  } finally {
    app.stop();
  }
});

test("includes optional gRPC session capture diagnostics in WebRTC stats", async () => {
  const { session, drained } = fakeScrcpySession(1);
  const adapted = adaptScrcpySession(session);
  const grpcSession: EmuSession = {
    ...adapted,
    mode: "grpc-screenshot",
    diagnostics: () => ({ grpcCapture: GRPC_CAPTURE_DIAGNOSTICS }),
  };
  const app = await createApp(
    {
      serial: session.serial,
      streamMode: "grpc-screenshot",
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => grpcSession,
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
    },
  );

  try {
    await drained;
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      capture: { grpc: GRPC_CAPTURE_DIAGNOSTICS },
    });
  } finally {
    app.stop();
  }
});
