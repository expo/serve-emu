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
import { adaptScrcpySession } from "../src/stream-session.ts";
import type {
  WebRtcPublisher,
  WebRtcPublisherSessionStats,
} from "../src/webrtc-publisher.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

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

  sampleAfter(elapsedMs: number): void {
    this.#nowMs += elapsedMs;
    this.#callback?.();
  }
}

function fakeScrcpySession(frameTotal: number): {
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
    statsForSession: (sessionId: string) =>
      sessionId === SESSION_ID ? stats : null,
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
