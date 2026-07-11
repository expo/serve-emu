import { describe, expect, test } from "bun:test";
import {
  SessionRecorder,
  type SessionRecorderRuntime,
} from "../src/session-recorder.ts";

type PendingSleep = {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

class ControlledRuntime implements SessionRecorderRuntime {
  nowMs = Date.UTC(2026, 0, 1);
  readonly sleepDurations: number[] = [];
  readonly pending: PendingSleep[] = [];

  now = () => this.nowMs;

  sleep = (ms: number, signal: AbortSignal) => {
    this.sleepDurations.push(ms);
    return new Promise<void>((resolve, reject) => {
      const entry: PendingSleep = {
        signal,
        resolve: () => this.#settle(entry, resolve),
        reject: (error) => this.#settle(entry, () => reject(error)),
        onAbort: () => this.#settle(entry, resolve),
      };
      if (signal.aborted) {
        resolve();
        return;
      }
      this.pending.push(entry);
      signal.addEventListener("abort", entry.onAbort, { once: true });
    });
  };

  resolveNext(): void {
    const entry = this.pending[0];
    if (!entry) throw new Error("no pending sleep");
    entry.resolve();
  }

  rejectNext(error: Error): void {
    const entry = this.pending[0];
    if (!entry) throw new Error("no pending sleep");
    entry.reject(error);
  }

  #settle(entry: PendingSleep, settle: () => void): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    entry.signal.removeEventListener("abort", entry.onAbort);
    settle();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionRecorder", () => {
  test("uses the injected clock and scales replay delays", async () => {
    const runtime = new ControlledRuntime();
    const recorder = new SessionRecorder(runtime);

    recorder.recordGesture({ type: "home" }, "test");
    runtime.nowMs += 600;
    recorder.recordLocation({ latitude: 51.5, longitude: -0.1 }, "test");

    expect(recorder.snapshot().events.map((event) => event.delayMs)).toEqual([
      0,
      600,
    ]);

    const calls: string[] = [];
    const replay = recorder.replay(
      {
        dispatchGesture: async (gesture) => {
          calls.push(`gesture:${gesture.type}`);
        },
        setLocation: (fix) => {
          calls.push(`location:${fix.latitude}`);
        },
      },
      2,
    );

    expect(runtime.sleepDurations).toEqual([0]);
    runtime.resolveNext();
    await flushMicrotasks();
    expect(calls).toEqual(["gesture:home"]);
    expect(runtime.sleepDurations).toEqual([0, 300]);

    runtime.nowMs += 300;
    runtime.resolveNext();
    const snapshot = await replay;

    expect(calls).toEqual(["gesture:home", "location:51.5"]);
    expect(snapshot.replaying).toBe(false);
    expect(snapshot.replayStartedAt).toBe("2026-01-01T00:00:00.600Z");
    expect(snapshot.replayCompletedAt).toBe("2026-01-01T00:00:00.900Z");
    expect(snapshot.lastError).toBeNull();
  });

  test("stop during a pending delay never dispatches the next event", async () => {
    const runtime = new ControlledRuntime();
    const recorder = new SessionRecorder(runtime);
    recorder.recordGesture({ type: "home" }, "test");
    runtime.nowMs += 1_000;
    recorder.recordGesture({ type: "back" }, "test");

    const calls: string[] = [];
    const replay = recorder.replay({
      dispatchGesture: async (gesture) => {
        calls.push(gesture.type);
      },
      setLocation: () => {},
    });

    runtime.resolveNext();
    await flushMicrotasks();
    expect(calls).toEqual(["home"]);
    expect(runtime.pending).toHaveLength(1);

    runtime.nowMs += 250;
    const stopping = recorder.stopReplay();
    expect(stopping.replaying).toBe(true);
    const snapshot = await replay;

    expect(calls).toEqual(["home"]);
    expect(runtime.pending).toHaveLength(0);
    expect(snapshot.replaying).toBe(false);
    expect(snapshot.replayCompletedAt).toBe("2026-01-01T00:00:01.250Z");
    expect(snapshot.lastError).toBeNull();
  });

  test("a scheduler failure resets replay state and remains retryable", async () => {
    const runtime = new ControlledRuntime();
    const recorder = new SessionRecorder(runtime);
    recorder.recordGesture({ type: "power" }, "test");

    const handlers = {
      dispatchGesture: async () => {},
      setLocation: () => {},
    };
    const failedReplay = recorder.replay(handlers);
    runtime.rejectNext(new Error("clock failed"));

    await expect(failedReplay).rejects.toThrow("clock failed");
    expect(recorder.snapshot()).toMatchObject({
      replaying: false,
      lastError: "clock failed",
    });

    const retry = recorder.replay(handlers);
    runtime.resolveNext();
    await expect(retry).resolves.toMatchObject({
      replaying: false,
      lastError: null,
    });
  });
});
