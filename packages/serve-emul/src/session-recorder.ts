import { normalizeTextForControl, type Gesture } from "./input.ts";
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

export type SessionSummary = {
  eventCount: number;
  retainedBytes: number;
  limits: {
    maxEvents: number;
    maxBytes: number;
  };
  droppedEvents: number;
  oldestEventId: number | null;
  newestEventId: number | null;
  oldestEventAt: string | null;
  newestEventAt: string | null;
  recording: boolean;
  replaying: boolean;
  replayStartedAt: string | null;
  replayCompletedAt: string | null;
  lastError: string | null;
};

export type SessionPage = {
  session: SessionSummary;
  events: RecordedEvent[];
  nextBefore: number | null;
  hasMore: boolean;
};

export type SessionExport = {
  session: SessionSummary;
  events: RecordedEvent[];
};

export type SessionPageOptions = {
  limit: number;
  before?: number;
};

type ReplayHandlers = {
  dispatchGesture: (gesture: Gesture) => Promise<void>;
  setLocation: (fix: GeoFix) => Promise<void> | void;
};

export type SessionRecorderOptions = {
  maxEvents?: number;
  maxBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type StoredEvent = {
  event: RecordedEvent;
  serializedBytes: number;
};

export const DEFAULT_MAX_SESSION_EVENTS = 2_000;
export const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024;

const EMPTY_ARRAY_BYTES = 2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function maxByteBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < EMPTY_ARRAY_BYTES) {
    throw new Error("maxBytes must be a safe integer of at least 2");
  }
  return value;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cloneGesture(gesture: Gesture): Gesture {
  if (gesture.type === "text") {
    return { type: "text", text: normalizeTextForControl(gesture.text) };
  }
  return { ...gesture };
}

function cloneLocation(location: GeoFix): GeoFix {
  return { ...location };
}

function cloneEvent(event: RecordedEvent): RecordedEvent {
  if (event.kind === "gesture") {
    return { ...event, gesture: cloneGesture(event.gesture) };
  }
  return { ...event, location: cloneLocation(event.location) };
}

export class SessionRecorder {
  readonly #slots: Array<StoredEvent | undefined>;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #head = 0;
  #eventCount = 0;
  #retainedBytes = EMPTY_ARRAY_BYTES;
  #droppedEvents = 0;
  #nextId = 1;
  #lastEventMs: number | null = null;
  #recording = true;
  #replaying = false;
  #stopReplay = false;
  #replayStartedAt: string | null = null;
  #replayCompletedAt: string | null = null;
  #lastError: string | null = null;

  constructor(options: SessionRecorderOptions = {}) {
    this.#maxEvents = positiveSafeInteger(
      options.maxEvents ?? DEFAULT_MAX_SESSION_EVENTS,
      "maxEvents",
    );
    this.#maxBytes = maxByteBudget(
      options.maxBytes ?? DEFAULT_MAX_SESSION_BYTES,
    );
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#slots = new Array<StoredEvent | undefined>(this.#maxEvents);
  }

  get isReplaying(): boolean {
    return this.#replaying;
  }

  recordGesture(gesture: Gesture, source: string): void {
    this.#record({ kind: "gesture", gesture: cloneGesture(gesture), source });
  }

  recordLocation(location: GeoFix, source: string): void {
    this.#record({ kind: "location", location: cloneLocation(location), source });
  }

  clear(): SessionSummary {
    for (let index = 0; index < this.#eventCount; index++) {
      this.#slots[(this.#head + index) % this.#maxEvents] = undefined;
    }
    this.#head = 0;
    this.#eventCount = 0;
    this.#retainedBytes = EMPTY_ARRAY_BYTES;
    this.#droppedEvents = 0;
    this.#lastEventMs = null;
    this.#lastError = null;
    this.#replayCompletedAt = null;
    return this.summary();
  }

  stopReplay(): SessionSummary {
    this.#stopReplay = true;
    return this.summary();
  }

  summary(): SessionSummary {
    const oldest = this.#eventCount > 0 ? this.#storedAt(0).event : null;
    const newest =
      this.#eventCount > 0
        ? this.#storedAt(this.#eventCount - 1).event
        : null;
    return {
      eventCount: this.#eventCount,
      retainedBytes: this.#retainedBytes,
      limits: {
        maxEvents: this.#maxEvents,
        maxBytes: this.#maxBytes,
      },
      droppedEvents: this.#droppedEvents,
      oldestEventId: oldest?.id ?? null,
      newestEventId: newest?.id ?? null,
      oldestEventAt: oldest?.at ?? null,
      newestEventAt: newest?.at ?? null,
      recording: this.#recording,
      replaying: this.#replaying,
      replayStartedAt: this.#replayStartedAt,
      replayCompletedAt: this.#replayCompletedAt,
      lastError: this.#lastError,
    };
  }

  page({ limit, before }: SessionPageOptions): SessionPage {
    positiveSafeInteger(limit, "limit");
    if (before !== undefined) positiveSafeInteger(before, "before");

    let end = this.#eventCount;
    if (before !== undefined) {
      while (end > 0 && this.#storedAt(end - 1).event.id >= before) {
        end--;
      }
    }
    const start = Math.max(0, end - limit);
    const events: RecordedEvent[] = [];
    for (let index = start; index < end; index++) {
      events.push(cloneEvent(this.#storedAt(index).event));
    }
    const hasMore = start > 0;
    return {
      session: this.summary(),
      events,
      nextBefore: hasMore && events.length > 0 ? events[0]!.id : null,
      hasMore,
    };
  }

  export(): SessionExport {
    return {
      session: this.summary(),
      events: this.#orderedEvents(),
    };
  }

  async replay(
    handlers: ReplayHandlers,
    multiplier = 1,
  ): Promise<SessionSummary> {
    if (this.#replaying) throw new Error("session replay is already running");
    if (this.#eventCount === 0) throw new Error("session has no recorded events");
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
      throw new Error("multiplier must be between 0 and 100");
    }

    const events = this.#orderedEvents();
    this.#replaying = true;
    this.#stopReplay = false;
    this.#replayStartedAt = this.#timestamp(this.#now());
    this.#replayCompletedAt = null;
    this.#lastError = null;

    try {
      for (const event of events) {
        if (this.#stopReplay) break;
        await this.#sleep(Math.max(0, event.delayMs / multiplier));
        if (this.#stopReplay) break;
        if (event.kind === "gesture") {
          await handlers.dispatchGesture(cloneGesture(event.gesture));
        } else {
          await handlers.setLocation(cloneLocation(event.location));
        }
      }
      this.#replayCompletedAt = this.#timestamp(this.#now());
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.#replaying = false;
      this.#stopReplay = false;
    }

    return this.summary();
  }

  #record(
    event:
      | { kind: "gesture"; gesture: Gesture; source: string }
      | { kind: "location"; location: GeoFix; source: string },
  ): void {
    if (!this.#recording || this.#replaying) return;
    const now = this.#now();
    const delayMs = this.#lastEventMs !== null
      ? Math.max(0, now - this.#lastEventMs)
      : 0;
    this.#lastEventMs = now;
    const base = {
      id: this.#nextId++,
      at: this.#timestamp(now),
      delayMs,
      source: event.source,
    };
    const recorded: RecordedEvent =
      event.kind === "gesture"
        ? { ...base, kind: "gesture", gesture: event.gesture }
        : { ...base, kind: "location", location: event.location };
    this.#append(recorded);
  }

  #append(event: RecordedEvent): void {
    const eventBytes = serializedBytes(event);
    if (EMPTY_ARRAY_BYTES + eventBytes > this.#maxBytes) {
      this.#droppedEvents++;
      return;
    }

    while (
      this.#eventCount > 0 &&
      (this.#eventCount >= this.#maxEvents ||
        this.#retainedBytes + 1 + eventBytes > this.#maxBytes)
    ) {
      this.#evictOldest();
    }

    const tail = (this.#head + this.#eventCount) % this.#maxEvents;
    this.#slots[tail] = { event, serializedBytes: eventBytes };
    this.#retainedBytes += eventBytes + (this.#eventCount > 0 ? 1 : 0);
    this.#eventCount++;
  }

  #evictOldest(): void {
    const oldest = this.#slots[this.#head];
    if (!oldest) throw new Error("session recorder ring buffer is inconsistent");
    this.#slots[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#maxEvents;
    this.#retainedBytes -=
      oldest.serializedBytes + (this.#eventCount > 1 ? 1 : 0);
    this.#eventCount--;
    this.#droppedEvents++;
    if (this.#eventCount === 0) {
      this.#head = 0;
      this.#retainedBytes = EMPTY_ARRAY_BYTES;
    }
  }

  #storedAt(index: number): StoredEvent {
    const stored = this.#slots[(this.#head + index) % this.#maxEvents];
    if (!stored) throw new Error("session recorder ring buffer is inconsistent");
    return stored;
  }

  #orderedEvents(): RecordedEvent[] {
    const events: RecordedEvent[] = [];
    for (let index = 0; index < this.#eventCount; index++) {
      events.push(cloneEvent(this.#storedAt(index).event));
    }
    return events;
  }

  #timestamp(ms: number): string {
    if (!Number.isFinite(ms)) throw new Error("now() must return a finite number");
    return new Date(ms).toISOString();
  }
}
