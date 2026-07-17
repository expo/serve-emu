import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  ControlInputError,
  ControlInputQueue,
  SocketControlWriter,
  type ControlBinaryWriter,
  type ControlInputClock,
} from "../src/control-input-queue.ts";

const SCREEN = { width: 1080, height: 1920 };

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function abortable(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      reject,
    );
  });
}

class FakeWriter implements ControlBinaryWriter {
  readonly writes: Buffer[] = [];
  readonly closeReasons: Error[] = [];
  #gates: Deferred[] = [];

  deferNext(): Deferred {
    const gate = deferred();
    this.#gates.push(gate);
    return gate;
  }

  write(packet: Buffer, signal: AbortSignal): Promise<void> {
    this.writes.push(Buffer.from(packet));
    const gate = this.#gates.shift();
    return gate ? abortable(gate.promise, signal) : Promise.resolve();
  }

  close(reason: Error): void {
    this.closeReasons.push(reason);
  }
}

type ClockWaiter = {
  ms: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};

class ManualClock implements ControlInputClock {
  readonly waits: ClockWaiter[] = [];

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: ClockWaiter = {
        ms,
        signal,
        resolve,
        reject,
        onAbort: () => {},
      };
      waiter.onAbort = () => {
        const index = this.waits.indexOf(waiter);
        if (index >= 0) this.waits.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waits.push(waiter);
    });
  }

  async advanceNext(): Promise<void> {
    const waiter = this.waits.shift();
    if (!waiter) throw new Error("manual clock has no pending sleep");
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
    await flushMicrotasks();
  }
}

function makeQueue(
  writer: FakeWriter,
  clock = new ManualClock(),
  options: { maxDepth?: number; maxBytes?: number } = {},
): ControlInputQueue {
  return new ControlInputQueue({
    writer,
    clock,
    maxDepth: options.maxDepth ?? 32,
    maxBytes: options.maxBytes ?? 4096,
  });
}

describe("ControlInputQueue", () => {
  test("keeps overlapping gestures atomic", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const queue = makeQueue(writer, clock);
    const swipe = queue.enqueue(
      { type: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 80 },
      SCREEN,
    );
    const tap = queue.enqueue({ type: "tap", x: 0.25, y: 0.5 }, SCREEN);

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]![1]).toBe(0);
    expect(clock.waits.map((waiter) => waiter.ms)).toEqual([10]);

    for (let i = 0; i < 8; i++) await clock.advanceNext();

    expect(writer.writes.slice(0, 9).map((packet) => packet[1])).toEqual([
      0, 2, 2, 2, 2, 2, 2, 2, 1,
    ]);
    await expect(swipe.completion).resolves.toEqual({ status: "completed" });
    expect(writer.writes[9]![1]).toBe(0);

    await clock.advanceNext();
    await expect(tap.completion).resolves.toEqual({ status: "completed" });
    expect(writer.writes[10]![1]).toBe(1);
  });

  test("does not start the next packet until the writer is ready", async () => {
    const writer = new FakeWriter();
    const firstWrite = writer.deferNext();
    const queue = makeQueue(writer);
    const key = queue.enqueue({ type: "key", keycode: 66 }, SCREEN);

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);

    firstWrite.resolve();
    await expect(key.completion).resolves.toEqual({ status: "completed" });
    expect(writer.writes).toHaveLength(2);
  });

  test("coalesces pending moves for the same pointer", async () => {
    const writer = new FakeWriter();
    const firstWrite = writer.deferNext();
    const queue = makeQueue(writer);
    const active = queue.enqueue({ type: "text", text: "hold" }, SCREEN);
    const firstMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.1, y: 0.2, pointerId: 7 },
      SCREEN,
    );
    const latestMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.9, y: 0.8, pointerId: 7 },
      SCREEN,
    );

    await flushMicrotasks();
    firstWrite.resolve();
    await expect(active.completion).resolves.toEqual({ status: "completed" });
    await expect(firstMove.completion).resolves.toEqual({ status: "coalesced" });
    await expect(latestMove.completion).resolves.toEqual({ status: "completed" });

    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[1]!.readInt32BE(10)).toBe(972);
    expect(writer.writes[1]!.readInt32BE(14)).toBe(1536);
  });

  test("rejects new input when the bounded queue is full", async () => {
    const writer = new FakeWriter();
    const firstWrite = writer.deferNext();
    const queue = makeQueue(writer, new ManualClock(), { maxDepth: 2 });
    const first = queue.enqueue({ type: "text", text: "a" }, SCREEN);
    const second = queue.enqueue({ type: "text", text: "b" }, SCREEN);

    await flushMicrotasks();
    expect(() => queue.enqueue({ type: "text", text: "c" }, SCREEN)).toThrow(
      new ControlInputError(
        "control-queue-overloaded",
        "scrcpy control input queue is full",
      ),
    );

    firstWrite.resolve();
    await expect(first.completion).resolves.toEqual({ status: "completed" });
    await expect(second.completion).resolves.toEqual({ status: "completed" });
  });

  test("rejects active and pending work when closed", async () => {
    const writer = new FakeWriter();
    writer.deferNext();
    const queue = makeQueue(writer);
    const active = queue.enqueue({ type: "text", text: "active" }, SCREEN);
    const pending = queue.enqueue({ type: "text", text: "pending" }, SCREEN);
    const activeResult = active.completion.catch((error) => error);
    const pendingResult = pending.completion.catch((error) => error);

    await flushMicrotasks();
    queue.close(new Error("device stopped"));

    expect(await activeResult).toMatchObject({ code: "control-queue-closed" });
    expect(await pendingResult).toMatchObject({ code: "control-queue-closed" });
    expect(queue.snapshot()).toMatchObject({ closed: true, depth: 0 });
  });
});

class FakeSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  readonly writes: Buffer[] = [];
  writeResult = false;

  write(packet: Buffer, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(packet));
    queueMicrotask(() => callback?.(null));
    return this.writeResult;
  }
}

describe("SocketControlWriter", () => {
  test("waits for drain after socket backpressure", async () => {
    const socket = new FakeSocket();
    const writer = new SocketControlWriter(socket as unknown as Socket);
    let settled = false;
    const write = writer
      .write(Buffer.from([1, 2, 3]), new AbortController().signal)
      .then(() => {
        settled = true;
      });

    await flushMicrotasks();
    expect(settled).toBe(false);
    socket.emit("drain");
    await write;
    expect(settled).toBe(true);
  });
});
