import { expect, test } from "bun:test";
import {
  GrpcFrameWritePacer,
  GrpcMmapNotificationScheduler,
  readMmapImageNotification,
  type GrpcMmapNotificationSchedulerClock,
} from "../src/grpc-session.ts";
import { IMG_FORMAT_RGB888, type EmuImage } from "../src/emulator-grpc.ts";

class ManualMicrotaskClock implements GrpcMmapNotificationSchedulerClock {
  nowMs = 0;
  readonly #microtasks: Array<() => void> = [];

  now(): number {
    return this.nowMs;
  }

  queueMicrotask(callback: () => void): void {
    this.#microtasks.push(callback);
  }

  flushMicrotasks(): void {
    while (this.#microtasks.length > 0) this.#microtasks.shift()!();
  }
}

function mmapNotification(seq: number, timestampUs: bigint): EmuImage {
  return {
    width: 436,
    height: 980,
    format: IMG_FORMAT_RGB888,
    rotation: 0,
    image: Buffer.alloc(0),
    seq,
    timestampUs,
  };
}

function simulateContinuouslyReadyWrites(options: {
  frameIntervalMs: number;
  writeCount: number;
  timerLatenessMs: (writeIndex: number) => number;
}): { writeTimesMs: number[]; waitsAfterWriteMs: number[] } {
  const pacer = new GrpcFrameWritePacer(options.frameIntervalMs);
  const writeTimesMs = [0];
  const waitsAfterWriteMs: number[] = [];
  let nowMs = 0;

  pacer.reset(nowMs);
  pacer.recordWrite(nowMs, false, true);
  waitsAfterWriteMs.push(pacer.waitMs(nowMs));

  for (let writeIndex = 1; writeIndex < options.writeCount; writeIndex++) {
    const scheduledAtMs = nowMs + pacer.waitMs(nowMs);
    nowMs = scheduledAtMs + options.timerLatenessMs(writeIndex);
    writeTimesMs.push(nowMs);
    pacer.recordWrite(nowMs, false, true);
    waitsAfterWriteMs.push(pacer.waitMs(nowMs));
  }

  return { writeTimesMs, waitsAfterWriteMs };
}

test("does not collapse a near-60 Hz MMAP pipeline to half-rate", () => {
  const clock = new ManualMicrotaskClock();
  const frameIntervalMs = 1_000 / 60;
  const arrivalIntervalMs = 16.6;
  const inputFrames = 120;
  const frameBytes = 436 * 980 * 3;
  const ownedSnapshot = Buffer.alloc(frameBytes);
  const writePacer = new GrpcFrameWritePacer(frameIntervalMs);
  writePacer.reset(0);

  let notifications = 0;
  let stableReadCopies = 0;
  let encoderWrites = 0;
  let maxEncoderPacingWaitMs = 0;

  const scheduler = new GrpcMmapNotificationScheduler({
    maxFps: 60,
    clock,
    consume(notification) {
      const result = readMmapImageNotification(notification, (byteLength) => {
        expect(byteLength).toBe(frameBytes);
        stableReadCopies++;
        return {
          image: ownedSnapshot,
          attempts: 1,
          bytesRead: frameBytes * 2,
          readMs: 0.2,
        };
      });
      expect(result.image).not.toBeNull();

      const pacingWaitMs = writePacer.waitMs(clock.now());
      maxEncoderPacingWaitMs = Math.max(
        maxEncoderPacingWaitMs,
        pacingWaitMs,
      );
      writePacer.recordWrite(clock.now() + pacingWaitMs, false, true);
      encoderWrites++;
    },
  });

  for (let index = 0; index < inputFrames; index++) {
    clock.nowMs = index * arrivalIntervalMs;
    notifications++;
    scheduler.push(
      mmapNotification(
        index + 1,
        1_000_000n + BigInt(Math.round(index * arrivalIntervalMs * 1_000)),
      ),
      clock.nowMs,
    );
    clock.flushMicrotasks();
  }
  scheduler.close();

  // A source only 0.4% over the configured ceiling may lose one or two frames
  // over this two-second window, but it must not alternate between accepted and
  // rejected notifications. Every accepted notification crosses the actual
  // metadata -> stable snapshot -> write-pacer -> encoder-write seams above.
  expect(notifications).toBe(inputFrames);
  expect(stableReadCopies).toBeGreaterThanOrEqual(inputFrames - 2);
  expect(encoderWrites).toBe(stableReadCopies);
  expect(maxEncoderPacingWaitMs).toBeLessThan(frameIntervalMs);
});

test("keeps a jittered 120 Hz MMAP source capped near 60 FPS", () => {
  const clock = new ManualMicrotaskClock();
  const targetFrameIntervalMs = 1_000 / 60;
  const sourceFrameIntervalMs = 1_000 / 120;
  const intervalJitterMs = [-0.35, 0.1, 0.25, -0.05, 0.05];
  const inputFrames = 240;
  let emittedFrames = 0;
  let elapsedMs = 0;

  const scheduler = new GrpcMmapNotificationScheduler({
    maxFps: 60,
    clock,
    consume() {
      emittedFrames++;
    },
  });

  for (let index = 0; index < inputFrames; index++) {
    if (index > 0) {
      elapsedMs +=
        sourceFrameIntervalMs +
        intervalJitterMs[(index - 1) % intervalJitterMs.length]!;
    }
    clock.nowMs = elapsedMs;
    scheduler.push(
      mmapNotification(index + 1, BigInt(Math.round(elapsedMs * 1_000))),
      elapsedMs,
    );
    clock.flushMicrotasks();
  }
  scheduler.close();

  const targetFramesForElapsedTime =
    Math.floor(elapsedMs / targetFrameIntervalMs) + 1;
  expect(emittedFrames).toBeGreaterThanOrEqual(
    targetFramesForElapsedTime - 1,
  );
  expect(emittedFrames).toBeLessThanOrEqual(targetFramesForElapsedTime + 1);
});

test("does not accumulate encoder-write timer lateness", () => {
  const frameIntervalMs = 1_000 / 60;
  const timerLatenessMs = 1.25;
  const pacer = new GrpcFrameWritePacer(frameIntervalMs);
  pacer.reset(0);

  pacer.recordWrite(0, false, true);
  const delayedWriteAtMs = frameIntervalMs + timerLatenessMs;
  pacer.recordWrite(delayedWriteAtMs, false, true);

  // The following deadline remains on the original 60 Hz grid. Resetting it
  // from the late callback would compound the 1.25 ms delay on every frame and
  // reduce a nominal 60 FPS stream to about 55.8 FPS.
  expect(pacer.waitMs(delayedWriteAtMs)).toBeCloseTo(
    frameIntervalMs - timerLatenessMs,
    6,
  );
});

test("sustains max FPS across repeated late encoder-write timers", () => {
  const frameIntervalMs = 1_000 / 60;
  const timerLatenessMs = 1.25;
  const writeCount = 601;
  const { writeTimesMs, waitsAfterWriteMs } =
    simulateContinuouslyReadyWrites({
      frameIntervalMs,
      writeCount,
      timerLatenessMs: () => timerLatenessMs,
    });

  const elapsedMs = writeTimesMs.at(-1)! - writeTimesMs[0]!;
  const sustainedFps = ((writeCount - 1) * 1_000) / elapsedMs;

  // A now-relative deadline would compound the 1.25 ms callback delay and
  // produce only 55.8 FPS. The phase grid retains essentially all 60 slots.
  expect(sustainedFps).toBeGreaterThan(59.9);
  expect(sustainedFps).toBeLessThanOrEqual(60);
  // Every accepted fresh write leaves a future deadline. Even after a late
  // callback, the caller cannot synchronously loop through missed slots.
  expect(Math.min(...waitsAfterWriteMs)).toBeGreaterThan(0);
});

test("bounds catch-up after intermittent long timer stalls", () => {
  const frameIntervalMs = 1_000 / 60;
  const ordinaryLatenessMs = [0.2, 1.1, 3.4, 0.05, 2.2];
  const { writeTimesMs, waitsAfterWriteMs } =
    simulateContinuouslyReadyWrites({
      frameIntervalMs,
      writeCount: 1_201,
      timerLatenessMs: (writeIndex) =>
        writeIndex % 137 === 0
          ? 42.5
          : ordinaryLatenessMs[writeIndex % ordinaryLatenessMs.length]!,
    });

  let maximumWritesPerSecond = 0;
  for (let start = 0; start < writeTimesMs.length; start++) {
    let end = start;
    while (
      end < writeTimesMs.length &&
      writeTimesMs[end]! < writeTimesMs[start]! + 1_000
    ) {
      end++;
    }
    maximumWritesPerSecond = Math.max(maximumWritesPerSecond, end - start);
  }

  // A stall can be followed by one short phase-recovery interval, but missed
  // slots are skipped rather than synchronously drained as a write burst.
  expect(maximumWritesPerSecond).toBeLessThanOrEqual(61);
  expect(Math.min(...waitsAfterWriteMs)).toBeGreaterThan(0);
});

test("recovers immediately after idle and skips missed write slots", () => {
  const pacer = new GrpcFrameWritePacer(20);
  pacer.reset(0);
  pacer.recordWrite(0, false, true);

  const resumedAtMs = 1_003;
  expect(pacer.waitMs(resumedAtMs)).toBe(0);
  pacer.recordWrite(resumedAtMs, false, true);

  // The pause does not create a catch-up loop. Only one fresh write is due,
  // and the next deadline advances to the first future point on the grid.
  expect(pacer.waitMs(resumedAtMs)).toBe(17);
  expect(pacer.waitMs(1_020)).toBe(0);
});

test("only accepted fresh writes advance the write-pacing grid", () => {
  const pacer = new GrpcFrameWritePacer(20);
  pacer.reset(100);

  pacer.recordWrite(100, false, false);
  expect(pacer.waitMs(100)).toBe(0);

  pacer.recordWrite(101, true, true);
  expect(pacer.waitMs(101)).toBe(0);

  pacer.recordWrite(103, false, true);
  expect(pacer.waitMs(103)).toBe(17);

  pacer.recordWrite(110, false, false);
  pacer.recordWrite(119, true, true);
  expect(pacer.waitMs(119)).toBe(1);

  pacer.recordWrite(120, false, true);
  expect(pacer.waitMs(120)).toBe(20);
});
