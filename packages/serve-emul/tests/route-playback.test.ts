import { describe, expect, test } from "bun:test";
import {
  RoutePlayback,
  type RoutePlaybackRuntime,
  type RoutePlaybackTimer,
} from "../src/route-playback.ts";
import type { GeoFix } from "../src/location.ts";

type FakeTimer = {
  id: number;
  callback: () => void;
  ms: number;
  active: boolean;
};

class FakeRuntime implements RoutePlaybackRuntime {
  nowMs = Date.UTC(2026, 0, 1);
  readonly timers: FakeTimer[] = [];
  #nextId = 1;

  now = () => this.nowMs;

  setInterval = (callback: () => void, ms: number): RoutePlaybackTimer => {
    const timer: FakeTimer = {
      id: this.#nextId++,
      callback,
      ms,
      active: true,
    };
    this.timers.push(timer);
    return timer;
  };

  clearInterval = (handle: RoutePlaybackTimer): void => {
    (handle as FakeTimer).active = false;
  };

  get activeTimers(): FakeTimer[] {
    return this.timers.filter((timer) => timer.active);
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const LONG_ROUTE = {
  waypoints: [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.01 },
  ],
  speedKph: 30,
  intervalMs: 1_000,
};

describe("RoutePlayback timer ownership", () => {
  test("pause, resume, and stop own exactly one live timer", async () => {
    const runtime = new FakeRuntime();
    const applied: GeoFix[] = [];
    const playback = new RoutePlayback({
      runtime,
      applyLocation: (fix) => {
        applied.push(fix);
      },
      onLocation: () => {},
    });

    await playback.start(LONG_ROUTE);
    expect(runtime.activeTimers).toHaveLength(1);
    const firstTimer = runtime.activeTimers[0]!;
    expect(firstTimer.ms).toBe(1_000);

    runtime.advance(250);
    expect(playback.pause()).toMatchObject({
      status: "paused",
      pausedAt: "2026-01-01T00:00:00.250Z",
    });
    expect(runtime.activeTimers).toHaveLength(0);

    runtime.advance(250);
    expect(playback.resume().status).toBe("running");
    expect(runtime.activeTimers).toHaveLength(1);
    const resumedTimer = runtime.activeTimers[0]!;

    // A callback already queued by a cleared interval must not re-enter after
    // resume, when the route is running again.
    firstTimer.callback();
    await flushMicrotasks();
    expect(applied).toHaveLength(1);

    runtime.advance(1_000);
    resumedTimer.callback();
    await flushMicrotasks();
    expect(applied).toHaveLength(2);
    expect(playback.snapshot().progressMeters).toBeGreaterThan(8);

    expect(playback.stop().status).toBe("idle");
    expect(runtime.activeTimers).toHaveLength(0);
    resumedTimer.callback();
    await flushMicrotasks();
    expect(applied).toHaveLength(2);
  });

  test("concurrent starts let only the newest generation install a timer", async () => {
    const runtime = new FakeRuntime();
    const applies: Array<{ fix: GeoFix; pending: Deferred<void> }> = [];
    const locations: GeoFix[] = [];
    const playback = new RoutePlayback({
      runtime,
      applyLocation: (fix) => {
        const pending = deferred<void>();
        applies.push({ fix, pending });
        return pending.promise;
      },
      onLocation: (fix) => locations.push(fix),
    });

    const firstStart = playback.start({
      waypoints: [{ latitude: 1, longitude: 1 }],
      intervalMs: 1_000,
    });
    const secondStart = playback.start({
      waypoints: [{ latitude: 2, longitude: 2 }],
      intervalMs: 2_000,
    });
    expect(applies.map(({ fix }) => fix.latitude)).toEqual([1, 2]);

    applies[0]!.pending.resolve();
    await firstStart;
    expect(runtime.activeTimers).toHaveLength(0);
    expect(locations).toEqual([]);

    applies[1]!.pending.resolve();
    const latest = await secondStart;
    expect(latest).toMatchObject({
      status: "running",
      intervalMs: 2_000,
      currentLocation: { latitude: 2, longitude: 2 },
    });
    expect(locations.map((fix) => fix.latitude)).toEqual([2]);
    expect(runtime.activeTimers).toHaveLength(1);
    expect(runtime.activeTimers[0]!.ms).toBe(2_000);
  });

  test("close during the initial apply invalidates the pending start", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<void>();
    const locations: GeoFix[] = [];
    const playback = new RoutePlayback({
      runtime,
      applyLocation: () => pending.promise,
      onLocation: (fix) => locations.push(fix),
    });

    const starting = playback.start(LONG_ROUTE);
    playback.close();
    expect(playback.snapshot().status).toBe("idle");
    pending.resolve();

    expect((await starting).status).toBe("idle");
    expect(runtime.activeTimers).toHaveLength(0);
    expect(locations).toEqual([]);
  });

  test("pause and resume during initial apply do not duplicate the timer", async () => {
    const runtime = new FakeRuntime();
    const pending = deferred<void>();
    const playback = new RoutePlayback({
      runtime,
      applyLocation: () => pending.promise,
      onLocation: () => {},
    });

    const starting = playback.start(LONG_ROUTE);
    playback.pause();
    playback.resume();
    expect(runtime.activeTimers).toHaveLength(1);

    pending.resolve();
    expect((await starting).status).toBe("running");
    expect(runtime.activeTimers).toHaveLength(1);
  });

  test("late failure from a stopped tick cannot mutate the idle snapshot", async () => {
    const runtime = new FakeRuntime();
    const pendingTick = deferred<void>();
    const locations: GeoFix[] = [];
    let applyCount = 0;
    const playback = new RoutePlayback({
      runtime,
      applyLocation: () => {
        applyCount++;
        return applyCount === 1 ? undefined : pendingTick.promise;
      },
      onLocation: (fix) => locations.push(fix),
    });

    await playback.start(LONG_ROUTE);
    runtime.advance(1_000);
    runtime.activeTimers[0]!.callback();
    await flushMicrotasks();
    expect(applyCount).toBe(2);

    playback.stop();
    pendingTick.reject(new Error("stale apply failed"));
    await flushMicrotasks();

    expect(playback.snapshot()).toMatchObject({
      status: "idle",
      lastError: null,
      progressMeters: 0,
    });
    expect(runtime.activeTimers).toHaveLength(0);
    expect(locations).toHaveLength(1);
  });

  test("completion applies the final waypoint and releases its timer", async () => {
    const runtime = new FakeRuntime();
    const locations: GeoFix[] = [];
    const playback = new RoutePlayback({
      runtime,
      applyLocation: () => {},
      onLocation: (fix) => locations.push(fix),
    });

    await playback.start({
      waypoints: [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 0.0001 },
      ],
      speedKph: 360,
      intervalMs: 1_000,
    });
    runtime.advance(1_000);
    runtime.activeTimers[0]!.callback();
    await flushMicrotasks();

    const snapshot = playback.snapshot();
    expect(snapshot.status).toBe("completed");
    expect(snapshot.completedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(snapshot.currentLocation?.longitude).toBeCloseTo(0.0001, 8);
    expect(runtime.activeTimers).toHaveLength(0);
    expect(locations).toHaveLength(2);
  });
});
