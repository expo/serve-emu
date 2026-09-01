import { describe, expect, test } from "bun:test";
import {
  decodeEmulatorImage,
  encodeKeyboardEvent,
  GrpcMessagePacer,
  GrpcMessageParser,
  parseEmulatorGrpcPort,
} from "../src/emulator-grpc.ts";

function grpcFrame(message: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + message.length);
  frame[0] = 0;
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

describe("gRPC message framing", () => {
  test("assembles byte-fragmented messages without cumulative concatenation", () => {
    const first = Buffer.allocUnsafe(4_096);
    for (let index = 0; index < first.length; index++) {
      first[index] = index % 251;
    }
    const second = Buffer.from("next frame");
    const input = Buffer.concat([grpcFrame(first), grpcFrame(second)]);
    const messages: Buffer[] = [];
    const parser = new GrpcMessageParser(8_192, (message) => {
      messages.push(message);
    });

    const originalConcat = Buffer.concat;
    let concatenatedBytes = 0;
    Object.defineProperty(Buffer, "concat", {
      configurable: true,
      value: (list: readonly Uint8Array[], totalLength?: number) => {
        const output = originalConcat(list, totalLength);
        concatenatedBytes += output.length;
        return output;
      },
    });
    try {
      for (let offset = 0; offset < input.length; offset++) {
        parser.push(input.subarray(offset, offset + 1));
      }
    } finally {
      Object.defineProperty(Buffer, "concat", {
        configurable: true,
        value: originalConcat,
      });
    }

    expect(messages).toEqual([first, second]);
    expect(concatenatedBytes).toBeLessThanOrEqual(input.length * 2);
  });

  test("validates fragmented headers before allocating message storage", () => {
    const oversizedHeader = Buffer.from([0, 0, 0, 0, 9]);
    const oversized = new GrpcMessageParser(8, () => {});
    oversized.push(oversizedHeader.subarray(0, 2));
    expect(() => oversized.push(oversizedHeader.subarray(2))).toThrow(
      "gRPC message 9 exceeds 8 byte limit",
    );

    const compressed = new GrpcMessageParser(8, () => {});
    expect(() => compressed.push(Buffer.from([1, 0, 0, 0, 0]))).toThrow(
      "compressed gRPC frames are unsupported",
    );
  });

  test("pauses upstream and emits at most one message per pacing slot", () => {
    class FakeClock {
      nowMs = 0;
      nextId = 1;
      tasks = new Map<
        number,
        { at: number; callback: () => void }
      >();

      now = () => this.nowMs;
      setTimeout = (callback: () => void, delayMs: number): number => {
        const id = this.nextId++;
        this.tasks.set(id, {
          at: this.nowMs + Math.max(0, delayMs),
          callback,
        });
        return id;
      };
      clearTimeout = (id: unknown): void => {
        this.tasks.delete(id as number);
      };
      advance(ms: number): void {
        const target = this.nowMs + ms;
        for (;;) {
          const next = [...this.tasks.entries()]
            .filter(([, task]) => task.at <= target)
            .sort((left, right) => left[1].at - right[1].at)[0];
          if (!next) break;
          const [id, task] = next;
          this.tasks.delete(id);
          this.nowMs = task.at;
          task.callback();
        }
        this.nowMs = target;
      }
    }

    const clock = new FakeClock();
    const stream = {
      pauses: 0,
      resumes: 0,
      pause() {
        this.pauses++;
      },
      resume() {
        this.resumes++;
      },
    };
    const messages: string[] = [];
    const failures: Error[] = [];
    const pacingEvents = { received: 0, emitted: 0, coalesced: 0 };
    const controller = new AbortController();
    const pacer = new GrpcMessagePacer({
      stream,
      maxMessageBytes: 1_024,
      messageIntervalMs: 100,
      signal: controller.signal,
      clock,
      onMessage: (message) => messages.push(message.toString("utf8")),
      onPacingEvent: (event) => {
        pacingEvents[event]++;
      },
      onError: (error) => failures.push(error),
    });

    pacer.push(
      Buffer.concat([
        grpcFrame(Buffer.from("one")),
        grpcFrame(Buffer.from("two")),
        grpcFrame(Buffer.from("three")),
      ]),
    );

    expect(messages).toEqual(["one"]);
    expect(pacingEvents).toEqual({ received: 3, emitted: 1, coalesced: 1 });
    expect(stream.pauses).toBe(1);
    expect(stream.resumes).toBe(0);

    clock.advance(99);
    expect(messages).toEqual(["one"]);
    clock.advance(1);
    expect(messages).toEqual(["one", "three"]);
    expect(stream.resumes).toBe(0);

    clock.advance(100);
    expect(stream.resumes).toBe(1);
    expect(failures).toEqual([]);
    expect(pacingEvents).toEqual({ received: 3, emitted: 2, coalesced: 1 });

    pacer.push(grpcFrame(Buffer.from("four")));
    expect(messages).toEqual(["one", "three", "four"]);
    expect(pacingEvents).toEqual({ received: 4, emitted: 3, coalesced: 1 });
    controller.abort(new Error("stream cancelled"));
    clock.advance(1_000);
    expect(stream.resumes).toBe(1);
    expect(messages).toEqual(["one", "three", "four"]);
  });
});

describe("emulator gRPC discovery", () => {
  test("parses active and newly started endpoint output", () => {
    expect(parseEmulatorGrpcPort('OK: { "port": "8554" }')).toBe(8554);
    expect(
      parseEmulatorGrpcPort("OK: gRPC endpoint available at port 43127"),
    ).toBe(43127);
  });

  test("rejects missing and invalid ports", () => {
    expect(parseEmulatorGrpcPort("OK")).toBeNull();
    expect(parseEmulatorGrpcPort("port 70000")).toBeNull();
  });
});

describe("emulator image protobuf", () => {
  test("rejects truncated length-delimited fields", () => {
    expect(() => decodeEmulatorImage(Buffer.from([0x0a, 0x05, 0x08]))).toThrow(
      "truncated protobuf length-delimited field",
    );
  });

  test("rejects overlong varints", () => {
    const overlong = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(() => decodeEmulatorImage(overlong)).toThrow(
      "protobuf varint exceeds 10 bytes",
    );
  });
});

describe("emulator keyboard protobuf", () => {
  test("encodes explicit key-down and key-up event types", () => {
    expect(
      encodeKeyboardEvent({ evdev: 28, eventType: "down" }),
    ).toEqual(Buffer.from([0x08, 0x01, 0x18, 0x1c]));
    expect(
      encodeKeyboardEvent({ evdev: 28, eventType: "up" }),
    ).toEqual(Buffer.from([0x08, 0x01, 0x10, 0x01, 0x18, 0x1c]));
    expect(
      encodeKeyboardEvent({ evdev: 28, eventType: "press" }),
    ).toEqual(Buffer.from([0x08, 0x01, 0x10, 0x02, 0x18, 0x1c]));
  });

  test("defaults key requests to a complete keypress", () => {
    expect(encodeKeyboardEvent({ key: "GoBack" })).toEqual(
      Buffer.concat([
        Buffer.from([0x10, 0x02, 0x22, 0x06]),
        Buffer.from("GoBack"),
      ]),
    );
  });
});
