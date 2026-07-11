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
  replayStatus: "idle" | "running" | "completed" | "cancelled" | "error";
  replayStartedAt: string | null;
  replayCompletedAt: string | null;
  replayCancelledAt: string | null;
  lastError: string | null;
};

export type ReplayHandlers = {
  dispatchGesture: (
    gesture: Gesture,
    signal: AbortSignal,
  ) => Promise<void> | void;
  setLocation: (fix: GeoFix, signal: AbortSignal) => Promise<void> | void;
};

export type SessionReplayClock = {
  now: () => number;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type SessionReplayRun = {
  snapshot: SessionSnapshot;
  completion: Promise<SessionSnapshot>;
};

export class SessionReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReplayValidationError";
  }
}

export class SessionReplayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReplayConflictError";
  }
}

export function sessionReplayErrorStatus(error: unknown): number {
  if (error instanceof SessionReplayValidationError) return 400;
  if (error instanceof SessionReplayConflictError) return 409;
  return 500;
}

export function parseSessionReplayMultiplier(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionReplayValidationError(
      "session replay payload must be an object",
    );
  }
  const raw = (value as Record<string, unknown>).multiplier;
  if (raw !== undefined && typeof raw !== "number") {
    throw new SessionReplayValidationError("multiplier must be a number");
  }
  const multiplier = raw ?? 1;
  validateMultiplier(multiplier);
  return multiplier;
}

type ActiveReplay = {
  id: number;
  controller: AbortController;
  completion: Promise<SessionSnapshot>;
};

const MAX_EVENTS = 2_000;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("session replay cancelled", "AbortError");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timeout = setTimeout(() => finish(resolve), Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const SYSTEM_REPLAY_CLOCK: SessionReplayClock = {
  now: Date.now,
  delay: abortableDelay,
};

function validateMultiplier(multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
    throw new SessionReplayValidationError(
      "multiplier must be between 0 and 100",
    );
  }
}

export class SessionRecorder {
  #events: RecordedEvent[] = [];
  #nextId = 1;
  #lastEventMs = 0;
  #recording = true;
  #replaying = false;
  #replayStatus: SessionSnapshot["replayStatus"] = "idle";
  #replayStartedAt: string | null = null;
  #replayCompletedAt: string | null = null;
  #replayCancelledAt: string | null = null;
  #lastError: string | null = null;
  #nextReplayId = 1;
  #activeReplay: ActiveReplay | null = null;
  #closed = false;
  #admissionEpoch = 0;
  #clock: SessionReplayClock;

  constructor(clock: SessionReplayClock = SYSTEM_REPLAY_CLOCK) {
    this.#clock = clock;
  }

  get isReplaying(): boolean {
    return this.#replaying;
  }

  get replayAdmissionEpoch(): number {
    return this.#admissionEpoch;
  }

  recordGesture(gesture: Gesture, source: string): void {
    this.#record({ kind: "gesture", gesture, source });
  }

  recordLocation(location: GeoFix, source: string): void {
    this.#record({ kind: "location", location, source });
  }

  clear(): SessionSnapshot {
    if (this.#closed) {
      throw new SessionReplayConflictError("session recorder is closed");
    }
    if (this.#activeReplay) {
      throw new SessionReplayConflictError(
        "cannot clear session while replay is running",
      );
    }
    this.#admissionEpoch++;
    this.#events = [];
    this.#lastEventMs = 0;
    this.#replayStatus = "idle";
    this.#replayStartedAt = null;
    this.#replayCompletedAt = null;
    this.#replayCancelledAt = null;
    this.#lastError = null;
    return this.snapshot();
  }

  async cancelAndWait(): Promise<SessionSnapshot> {
    this.#admissionEpoch++;
    return this.#cancelActiveReplay();
  }

  async dispose(): Promise<SessionSnapshot> {
    this.#admissionEpoch++;
    this.#closed = true;
    this.#recording = false;
    return this.#cancelActiveReplay();
  }

  async #cancelActiveReplay(): Promise<SessionSnapshot> {
    const replay = this.#activeReplay;
    if (!replay) return this.snapshot();
    replay.controller.abort();
    await replay.completion;
    return this.snapshot();
  }

  snapshot(): SessionSnapshot {
    return {
      events: this.#events,
      recording: this.#recording,
      replaying: this.#replaying,
      replayStatus: this.#replayStatus,
      replayStartedAt: this.#replayStartedAt,
      replayCompletedAt: this.#replayCompletedAt,
      replayCancelledAt: this.#replayCancelledAt,
      lastError: this.#lastError,
    };
  }

  startReplay(handlers: ReplayHandlers, multiplier = 1): SessionReplayRun {
    if (this.#closed) {
      throw new SessionReplayConflictError("session recorder is closed");
    }
    if (this.#activeReplay) {
      throw new SessionReplayConflictError(
        "session replay is already running",
      );
    }
    if (this.#events.length === 0) {
      throw new SessionReplayValidationError(
        "session has no recorded events",
      );
    }
    validateMultiplier(multiplier);

    const events = [...this.#events];
    const replay: ActiveReplay = {
      id: this.#nextReplayId++,
      controller: new AbortController(),
      completion: Promise.resolve(this.snapshot()),
    };
    this.#activeReplay = replay;
    this.#replaying = true;
    this.#replayStatus = "running";
    this.#replayStartedAt = new Date(this.#clock.now()).toISOString();
    this.#replayCompletedAt = null;
    this.#replayCancelledAt = null;
    this.#lastError = null;
    replay.completion = Promise.resolve().then(() =>
      this.#executeReplay(replay, events, handlers, multiplier),
    );
    return { snapshot: this.snapshot(), completion: replay.completion };
  }

  async #executeReplay(
    replay: ActiveReplay,
    events: RecordedEvent[],
    handlers: ReplayHandlers,
    multiplier: number,
  ): Promise<SessionSnapshot> {
    let outcome: "completed" | "cancelled" | "error" = "completed";
    try {
      for (const event of events) {
        this.#assertReplayActive(replay);
        await this.#clock.delay(
          Math.max(0, event.delayMs / multiplier),
          replay.controller.signal,
        );
        this.#assertReplayActive(replay);
        if (event.kind === "gesture") {
          await handlers.dispatchGesture(
            event.gesture,
            replay.controller.signal,
          );
        } else {
          await handlers.setLocation(
            event.location,
            replay.controller.signal,
          );
        }
        this.#assertReplayActive(replay);
      }
    } catch (err) {
      if (
        replay.controller.signal.aborted ||
        this.#activeReplay?.id !== replay.id
      ) {
        outcome = "cancelled";
      } else {
        outcome = "error";
        this.#lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.#activeReplay?.id === replay.id) {
        const finishedAt = new Date(this.#clock.now()).toISOString();
        this.#replaying = false;
        this.#replayStatus = outcome;
        this.#replayCompletedAt =
          outcome === "completed" ? finishedAt : null;
        this.#replayCancelledAt =
          outcome === "cancelled" ? finishedAt : null;
        this.#activeReplay = null;
      }
    }
    return this.snapshot();
  }

  #assertReplayActive(replay: ActiveReplay): void {
    if (
      replay.controller.signal.aborted ||
      this.#activeReplay?.id !== replay.id
    ) {
      throw abortReason(replay.controller.signal);
    }
  }

  #record(
    event:
      | { kind: "gesture"; gesture: Gesture; source: string }
      | { kind: "location"; location: GeoFix; source: string },
  ): void {
    if (this.#closed || !this.#recording || this.#replaying) return;
    const now = this.#clock.now();
    const delayMs = this.#lastEventMs ? Math.max(0, now - this.#lastEventMs) : 0;
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
