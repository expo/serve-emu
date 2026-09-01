import { describe, expect, test } from "bun:test";
import {
  decodeEmulatorImage,
  encodeKeyboardEvent,
  parseEmulatorGrpcPort,
} from "../src/emulator-grpc.ts";

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
