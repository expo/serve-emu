import type { Gesture } from "./input.ts";
import type { GeoFix } from "./location.ts";

export type RecordedEvent =
  | {
      id: number;
      at: string;
      delayMs: number;
      source: string;
      kind: "gesture";
      gesture: Gesture;
    }
  | {
      id: number;
      at: string;
      delayMs: number;
      source: string;
      kind: "location";
      location: GeoFix;
    };

export type SessionSnapshot = {
  events: RecordedEvent[];
  recording: boolean;
  replaying: boolean;
  replayStartedAt: string | null;
  replayCompletedAt: string | null;
  lastError: string | null;
};

type ReplayHandlers = {
  dispatchGesture: (gesture: Gesture) => Promise<void>;
  setLocation: (fix: GeoFix) => Promise<void> | void;
};

export type SessionRecorderRuntime = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

const MAX_EVENTS = 2_000;

const SYSTEM_RUNTIME: SessionRecorderRuntime = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      const onAbort = () => {
        clearTimeout(timer);
        done();
      };
      function done() {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export class SessionRecorder {
  #runtime: SessionRecorderRuntime;
  #events: RecordedEvent[] = [];
  #nextId = 1;
  #lastEventMs: number | null = null;
  #recording = true;
  #replaying = false;
  #replayController: AbortController | null = null;
  #replayStartedAt: string | null = null;
  #replayCompletedAt: string | null = null;
  #lastError: string | null = null;

  constructor(runtime: SessionRecorderRuntime = SYSTEM_RUNTIME) {
    this.#runtime = runtime;
  }

  get isReplaying(): boolean {
    return this.#replaying;
  }

  recordGesture(gesture: Gesture, source: string): void {
    this.#record({ kind: "gesture", gesture, source });
  }

  recordLocation(location: GeoFix, source: string): void {
    this.#record({ kind: "location", location, source });
  }

  clear(): SessionSnapshot {
    this.#events = [];
    this.#lastEventMs = null;
    this.#lastError = null;
    this.#replayCompletedAt = null;
    return this.snapshot();
  }

  stopReplay(): SessionSnapshot {
    this.#replayController?.abort();
    return this.snapshot();
  }

  snapshot(): SessionSnapshot {
    return {
      events: this.#events,
      recording: this.#recording,
      replaying: this.#replaying,
      replayStartedAt: this.#replayStartedAt,
      replayCompletedAt: this.#replayCompletedAt,
      lastError: this.#lastError,
    };
  }

  async replay(handlers: ReplayHandlers, multiplier = 1): Promise<SessionSnapshot> {
    if (this.#replaying) throw new Error("session replay is already running");
    if (this.#events.length === 0) throw new Error("session has no recorded events");
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
      throw new Error("multiplier must be between 0 and 100");
    }

    const events = [...this.#events];
    const controller = new AbortController();
    const { signal } = controller;
    this.#replaying = true;
    this.#replayController = controller;
    this.#replayStartedAt = new Date(this.#runtime.now()).toISOString();
    this.#replayCompletedAt = null;
    this.#lastError = null;

    try {
      for (const event of events) {
        if (signal.aborted) break;
        try {
          await this.#runtime.sleep(
            Math.max(0, event.delayMs / multiplier),
            signal,
          );
        } catch (err) {
          if (signal.aborted) break;
          throw err;
        }
        // stopReplay() may fire while the delay is pending. Check again before
        // dispatch so cancellation can never leak the next event to a newly
        // selected device/session.
        if (signal.aborted) break;
        if (event.kind === "gesture") {
          await handlers.dispatchGesture(event.gesture);
        } else {
          await handlers.setLocation(event.location);
        }
      }
      this.#replayCompletedAt = new Date(this.#runtime.now()).toISOString();
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (this.#replayController === controller) {
        this.#replaying = false;
        this.#replayController = null;
      }
    }

    return this.snapshot();
  }

  #record(
    event:
      | { kind: "gesture"; gesture: Gesture; source: string }
      | { kind: "location"; location: GeoFix; source: string },
  ): void {
    if (!this.#recording || this.#replaying) return;
    const now = this.#runtime.now();
    const delayMs =
      this.#lastEventMs === null ? 0 : Math.max(0, now - this.#lastEventMs);
    this.#lastEventMs = now;
    const base = {
      id: this.#nextId++,
      at: new Date(now).toISOString(),
      delayMs,
      source: event.source,
    };
    this.#events.push(
      event.kind === "gesture"
        ? { ...base, kind: "gesture", gesture: event.gesture }
        : { ...base, kind: "location", location: event.location },
    );
    if (this.#events.length > MAX_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }
  }
}
