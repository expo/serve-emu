import { describe, expect, test } from "bun:test";
import {
  parseSessionReplayMultiplier,
  SessionRecorder,
  SessionReplayConflictError,
  SessionReplayValidationError,
  type SessionReplayClock,
} from "../src/session-recorder.ts";
import {
  clearSessionReplayResponse,
  sessionReplayErrorResponse,
  startSessionReplayResponse,
  stopSessionReplayResponse,
} from "../src/session-replay-api.ts";
import { createSessionReplayHandlers } from "../src/session-replay-session.ts";
import { disposeReplayBefore } from "../src/session-replay-lifecycle.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PendingDelay = {
  ms: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

class ManualReplayClock implements SessionReplayClock {
  nowMs = Date.UTC(2026, 0, 1);
  pending: PendingDelay[] = [];
  requestedMs: number[] = [];
  #pendingWaiters: Array<{ count: number; resolve: () => void }> = [];

  now = () => this.nowMs;

  delay = (ms: number, signal: AbortSignal): Promise<void> => {
    this.requestedMs.push(ms);
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        fn();
      };
      const onAbort = () => finish(() => reject(signal.reason));
      const pending: PendingDelay = {
        ms,
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
      };
      this.pending.push(pending);
      this.#notifyPendingWaiters();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  advance(ms: number): void {
    this.nowMs += ms;
  }

  resolveNext(): void {
    const pending = this.pending[0];
    if (!pending) throw new Error("no pending replay delay");
    pending.resolve();
  }

  waitForPending(count = 1): Promise<void> {
    if (this.pending.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#pendingWaiters.push({ count, resolve });
    });
  }

  #notifyPendingWaiters(): void {
    for (const waiter of [...this.#pendingWaiters]) {
      if (this.pending.length < waiter.count) continue;
      this.#pendingWaiters.splice(this.#pendingWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => "resolved" as const),
    Promise.resolve("pending" as const),
  ]);
  expect(state).toBe("pending");
}

function recordTwoGestures(
  recorder: SessionRecorder,
  clock: ManualReplayClock,
): void {
  recorder.recordGesture({ type: "tap", x: 0.1, y: 0.2 }, "test:a");
  clock.advance(42);
  recorder.recordGesture({ type: "home" }, "test:b");
}

const noLocation = () => {};

describe("SessionRecorder replay lifecycle", () => {
  test("commits replay state synchronously and cancels before the first delay", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "test");
    const dispatched: string[] = [];

    const replay = recorder.startReplay({
      dispatchGesture: (gesture) => dispatched.push(gesture.type),
      setLocation: noLocation,
    });
    expect(replay.snapshot).toMatchObject({
      replaying: true,
      replayStatus: "running",
      replayStartedAt: new Date(clock.nowMs).toISOString(),
      replayCompletedAt: null,
      replayCancelledAt: null,
    });

    const stopped = await recorder.cancelAndWait();
    expect(dispatched).toEqual([]);
    expect(clock.pending).toHaveLength(0);
    expect(stopped).toMatchObject({
      replaying: false,
      replayStatus: "cancelled",
      replayCompletedAt: null,
      replayCancelledAt: new Date(clock.nowMs).toISOString(),
      lastError: null,
    });
  });

  test("stop during the next delay prevents later events", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recordTwoGestures(recorder, clock);
    const dispatched: string[] = [];
    recorder.startReplay({
      dispatchGesture: (gesture) => dispatched.push(gesture.type),
      setLocation: noLocation,
    });

    await clock.waitForPending();
    expect(clock.pending[0]?.ms).toBe(0);
    clock.resolveNext();
    await clock.waitForPending();
    expect(dispatched).toEqual(["tap"]);
    expect(clock.pending[0]?.ms).toBe(42);

    await recorder.cancelAndWait();
    expect(dispatched).toEqual(["tap"]);
    expect(clock.pending).toHaveLength(0);
  });

  test("rechecks cancellation after a delay resolves but before dispatch", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recordTwoGestures(recorder, clock);
    const dispatched: string[] = [];
    recorder.startReplay({
      dispatchGesture: (gesture) => dispatched.push(gesture.type),
      setLocation: noLocation,
    });

    await clock.waitForPending();
    clock.resolveNext();
    await clock.waitForPending();
    expect(dispatched).toEqual(["tap"]);
    clock.resolveNext();
    const stopped = recorder.cancelAndWait();
    await stopped;

    expect(dispatched).toEqual(["tap"]);
    expect(recorder.snapshot().replayStatus).toBe("cancelled");
  });

  test("stop response waits for an in-flight handler", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "power" }, "test");
    const handler = deferred<void>();
    const handlerEntered = deferred<void>();
    let handlerStarted = false;
    recorder.startReplay({
      dispatchGesture: () => {
        handlerStarted = true;
        handlerEntered.resolve();
        return handler.promise;
      },
      setLocation: noLocation,
    });
    await clock.waitForPending();
    clock.resolveNext();
    await handlerEntered.promise;
    expect(handlerStarted).toBe(true);

    let stopResolved = false;
    const responsePromise = stopSessionReplayResponse(recorder).then(
      (response) => {
        stopResolved = true;
        return response;
      },
    );
    await expectPromisePending(responsePromise);
    expect(stopResolved).toBe(false);

    handler.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      session: { replaying: false, replayStatus: "cancelled" },
    });
  });

  test("normal completion records only the completion timestamp", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recordTwoGestures(recorder, clock);
    const dispatched: string[] = [];
    const replay = recorder.startReplay(
      {
        dispatchGesture: (gesture) => dispatched.push(gesture.type),
        setLocation: noLocation,
      },
      2,
    );
    await clock.waitForPending();
    clock.resolveNext();
    await clock.waitForPending();
    expect(clock.pending[0]?.ms).toBe(21);
    clock.advance(100);
    clock.resolveNext();

    const completed = await replay.completion;
    expect(dispatched).toEqual(["tap", "home"]);
    expect(clock.requestedMs).toEqual([0, 21]);
    expect(completed).toMatchObject({
      replaying: false,
      replayStatus: "completed",
      replayCompletedAt: new Date(clock.nowMs).toISOString(),
      replayCancelledAt: null,
      lastError: null,
    });
    expect(await recorder.cancelAndWait()).toEqual(completed);
  });

  test("replays recorded location events through the location handler", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordLocation(
      { latitude: 51.5, longitude: -0.12 },
      "test:location",
    );
    const locations: Array<{ latitude: number; longitude: number }> = [];
    const replay = recorder.startReplay({
      dispatchGesture: () => {},
      setLocation: (fix) => locations.push(fix),
    });
    await clock.waitForPending();
    clock.resolveNext();
    await replay.completion;

    expect(locations).toEqual([{ latitude: 51.5, longitude: -0.12 }]);
    expect(recorder.snapshot().replayStatus).toBe("completed");
  });

  test("handler failure records an error and releases the active run", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "back" }, "test");
    const replay = recorder.startReplay({
      dispatchGesture: () => {
        throw new Error("dispatch failed");
      },
      setLocation: noLocation,
    });
    await clock.waitForPending();
    clock.resolveNext();
    const failed = await replay.completion;

    expect(failed).toMatchObject({
      replaying: false,
      replayStatus: "error",
      replayCompletedAt: null,
      replayCancelledAt: null,
      lastError: "dispatch failed",
    });

    const next = recorder.startReplay({
      dispatchGesture: () => {},
      setLocation: noLocation,
    });
    await recorder.cancelAndWait();
    expect((await next.completion).replayStatus).toBe("cancelled");
  });

  test("dispose blocks new starts and waits for the active handler", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "recents" }, "test");
    const handler = deferred<void>();
    const handlerEntered = deferred<void>();
    recorder.startReplay({
      dispatchGesture: () => {
        handlerEntered.resolve();
        return handler.promise;
      },
      setLocation: noLocation,
    });
    await clock.waitForPending();
    clock.resolveNext();
    await handlerEntered.promise;

    let disposed = false;
    const disposing = recorder.dispose().then((snapshot) => {
      disposed = true;
      return snapshot;
    });
    expect(() =>
      recorder.startReplay({
        dispatchGesture: () => {},
        setLocation: noLocation,
      }),
    ).toThrow(SessionReplayConflictError);
    await expectPromisePending(disposing);
    expect(disposed).toBe(false);
    handler.resolve();

    expect(await disposing).toMatchObject({
      recording: false,
      replaying: false,
      replayStatus: "cancelled",
    });
  });
});

describe("Session replay API contracts", () => {
  test("empty history and invalid multipliers return bad requests", async () => {
    const empty = new SessionRecorder(new ManualReplayClock());
    const handlers = {
      dispatchGesture: () => {},
      setLocation: noLocation,
    };
    const emptyResponse = startSessionReplayResponse(empty, handlers, 1);
    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.json()).toEqual({
      ok: false,
      error: "session has no recorded events",
    });

    for (const multiplier of [0, -1, Number.NaN, Infinity, 101]) {
      expect(() => parseSessionReplayMultiplier({ multiplier })).toThrow(
        SessionReplayValidationError,
      );
    }
    expect(() => parseSessionReplayMultiplier([])).toThrow(
      SessionReplayValidationError,
    );
    for (const multiplier of ["2", true, null, [2]]) {
      expect(() => parseSessionReplayMultiplier({ multiplier })).toThrow(
        "multiplier must be a number",
      );
    }

    const clock = new ManualReplayClock();
    const invalidRateRecorder = new SessionRecorder(clock);
    invalidRateRecorder.recordGesture({ type: "home" }, "test");
    for (const multiplier of [0, -1, Number.NaN, Infinity, 101]) {
      const response = startSessionReplayResponse(
        invalidRateRecorder,
        handlers,
        multiplier,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "multiplier must be between 0 and 100",
      });
    }
    expect(invalidRateRecorder.snapshot().replayStatus).toBe("idle");
  });

  test("duplicate replay returns conflict after the first state commit", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "test");
    const handlers = {
      dispatchGesture: () => {},
      setLocation: noLocation,
    };

    const started = startSessionReplayResponse(recorder, handlers, 1);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      ok: true,
      session: { replaying: true, replayStatus: "running" },
    });
    const duplicate = startSessionReplayResponse(recorder, handlers, 1);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      ok: false,
      error: "session replay is already running",
    });
    await recorder.cancelAndWait();
  });

  test("stale session admission returns conflict without starting", async () => {
    const recorder = new SessionRecorder(new ManualReplayClock());
    recorder.recordGesture({ type: "home" }, "test");
    const response = startSessionReplayResponse(
      recorder,
      { dispatchGesture: () => {}, setLocation: noLocation },
      1,
      () => false,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "device session changed before session replay start",
    });
    expect(recorder.snapshot().replayStatus).toBe("idle");
  });

  test("a completed stop invalidates replay starts whose body was still pending", async () => {
    const recorder = new SessionRecorder(new ManualReplayClock());
    recorder.recordGesture({ type: "home" }, "test");
    const capturedEpoch = recorder.replayAdmissionEpoch;

    await recorder.cancelAndWait();
    const response = startSessionReplayResponse(
      recorder,
      { dispatchGesture: () => {}, setLocation: noLocation },
      1,
      () => capturedEpoch === recorder.replayAdmissionEpoch,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "device session changed before session replay start",
    });
    expect(recorder.snapshot().replayStatus).toBe("idle");
  });

  test("clear rejects active replay and resets inactive replay metadata", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "power" }, "test");
    recorder.startReplay({
      dispatchGesture: () => {},
      setLocation: noLocation,
    });

    const activeClear = clearSessionReplayResponse(recorder);
    expect(activeClear.status).toBe(409);
    expect(await activeClear.json()).toEqual({
      ok: false,
      error: "cannot clear session while replay is running",
    });
    expect(recorder.snapshot().events).toHaveLength(1);
    await recorder.cancelAndWait();

    const cleared = clearSessionReplayResponse(recorder);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      ok: true,
      session: {
        events: [],
        replayStatus: "idle",
        replayStartedAt: null,
        replayCompletedAt: null,
        replayCancelledAt: null,
        lastError: null,
      },
    });
  });

  test("unexpected admission errors return server errors", async () => {
    const response = sessionReplayErrorResponse(
      new Error("unexpected replay failure"),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unexpected replay failure",
    });
  });
});

describe("session replay handler ownership", () => {
  test("generation changes cannot dispatch through the replacement context", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "test");
    const dispatched: string[] = [];
    let generation = 7;
    const capturedDevice = "device-a";
    const handlers = createSessionReplayHandlers({
      generation,
      getGeneration: () => generation,
      dispatchGesture: () => dispatched.push(capturedDevice),
      setLocation: noLocation,
    });
    const replay = recorder.startReplay(handlers);
    await clock.waitForPending();
    generation++;
    clock.resolveNext();
    const result = await replay.completion;

    expect(dispatched).toEqual([]);
    expect(result).toMatchObject({
      replayStatus: "error",
      lastError: "device session changed during session replay",
    });
  });

  test("dispose before generation replacement drains old handlers", async () => {
    const clock = new ManualReplayClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "test");
    const handler = deferred<void>();
    const handlerEntered = deferred<void>();
    let generation = 1;
    const handledGenerations: number[] = [];
    const handlers = createSessionReplayHandlers({
      generation,
      getGeneration: () => generation,
      dispatchGesture: async () => {
        handledGenerations.push(generation);
        handlerEntered.resolve();
        await handler.promise;
      },
      setLocation: noLocation,
    });
    recorder.startReplay(handlers);
    await clock.waitForPending();
    clock.resolveNext();
    await handlerEntered.promise;

    const lifecycle: string[] = [];
    const draining = disposeReplayBefore({
      recorder,
      stopRoute: () => lifecycle.push("route-stopped"),
      afterReplayStopped: () => {
        generation = 2;
        lifecycle.push("context-replaced");
      },
    });
    expect(lifecycle).toEqual(["route-stopped"]);
    expect(handledGenerations).toEqual([1]);
    handler.resolve();
    await draining;

    expect(lifecycle).toEqual(["route-stopped", "context-replaced"]);
    expect(generation).toBe(2);
    expect(handledGenerations).toEqual([1]);
  });
});
