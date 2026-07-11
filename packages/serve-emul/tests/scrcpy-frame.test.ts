import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  FramedReader,
  ScrcpyStreamError,
  parseFrameHeader,
  parseVideoPreamble,
  readFrame,
} from "../src/scrcpy.ts";
import {
  PROTOCOL_GOLDEN_HEX,
  goldenBytes,
} from "./fixtures/protocol-golden.ts";

function frameHeader(
  protocol: 3 | 4,
  o: { pts?: bigint; size: number; config?: boolean; key?: boolean },
) {
  const h = Buffer.alloc(12);
  let flags = 0n;
  if (protocol === 4) {
    if (o.config) flags |= 1n << 62n;
    if (o.key) flags |= 1n << 61n;
  } else {
    if (o.config) flags |= 1n << 63n;
    if (o.key) flags |= 1n << 62n;
  }
  h.writeBigUInt64BE((o.pts ?? 0n) | flags, 0);
  h.writeUInt32BE(o.size, 8);
  return h;
}

function preamble(
  tail: "v3-preamble-tail" | "v4-preamble-tail",
  dummy: boolean,
  extra = Buffer.alloc(0),
): Buffer {
  const deviceName = Buffer.alloc(64);
  deviceName.write("Pixel Golden", "utf8");
  return Buffer.concat([
    ...(dummy ? [Buffer.of(0)] : []),
    deviceName,
    Buffer.from(goldenBytes(tail)),
    extra,
  ]);
}

class MockSock extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function makeReader() {
  const s = new MockSock();
  return { s, r: new FramedReader(s as unknown as Socket) };
}

describe("documented scrcpy protocol goldens", () => {
  test.each([
    { protocol: 3 as const, tail: "v3-preamble-tail" as const, dummy: false },
    { protocol: 3 as const, tail: "v3-preamble-tail" as const, dummy: true },
    { protocol: 4 as const, tail: "v4-preamble-tail" as const, dummy: false },
    { protocol: 4 as const, tail: "v4-preamble-tail" as const, dummy: true },
  ])(
    "parses v$protocol preamble at the dummy=$dummy metadata offset",
    ({ protocol, tail, dummy }) => {
      const extra = Buffer.of(0xde, 0xad, 0xbe, 0xef);
      const packet = preamble(tail, dummy, extra);
      const metadataOffset = 64 + (dummy ? 1 : 0);
      expect(
        packet
          .subarray(metadataOffset, metadataOffset + goldenBytes(tail).length)
          .toString("hex"),
      ).toBe(PROTOCOL_GOLDEN_HEX[tail]);
      expect(parseVideoPreamble(packet)).toEqual({
        deviceName: "Pixel Golden",
        codecName: "h264",
        width: 1080,
        height: 1920,
        protocol,
        extra,
      });
    },
  );

  test.each([
    { protocol: 3 as const, name: "v3-key-header" as const },
    { protocol: 4 as const, name: "v4-key-header" as const },
  ])("parses the exact v$protocol key-frame flag", ({ protocol, name }) => {
    expect(parseFrameHeader(Buffer.from(goldenBytes(name)), protocol)).toEqual({
      kind: "frame",
      size: 4,
      pts: 42n,
      isConfig: false,
      isKey: true,
    });
  });

  test.each([
    { protocol: 3 as const, header: "800000000000000000000004" },
    { protocol: 4 as const, header: "400000000000000000000004" },
  ])("parses the v$protocol config flag independently", ({ protocol, header }) => {
    expect(parseFrameHeader(Buffer.from(header, "hex"), protocol)).toEqual({
      kind: "frame",
      size: 4,
      pts: 0n,
      isConfig: true,
      isKey: false,
    });
  });

  test("parses the v4 initial session separately from video frames", () => {
    const session = Buffer.from(goldenBytes("v4-preamble-tail")).subarray(4);
    expect(parseFrameHeader(session, 4)).toEqual({
      kind: "session",
      width: 1080,
      height: 1920,
      clientResized: false,
    });
  });

  test("parses the exact v4 resized-session flag", () => {
    expect(
      parseFrameHeader(Buffer.from(goldenBytes("v4-resize")), 4),
    ).toEqual({
      kind: "session",
      width: 1080,
      height: 1920,
      clientResized: true,
    });
  });

  test.each([
    { protocol: 3 as const, name: "v3-key-header" as const },
    { protocol: 4 as const, name: "v4-key-header" as const },
  ])(
    "reassembles a fragmented v$protocol header and payload",
    async ({ protocol, name }) => {
      const { s, r } = makeReader();
      const promise = readFrame(r, protocol);
      const header = Buffer.from(goldenBytes(name));
      s.emit("data", header.subarray(0, 1));
      s.emit("data", header.subarray(1, 9));
      s.emit("data", header.subarray(9));
      s.emit("data", Buffer.of(0x01, 0x02));
      s.emit("data", Buffer.of(0x03, 0x04));
      expect(await promise).toEqual({
        type: "frame",
        data: Buffer.of(0x01, 0x02, 0x03, 0x04),
        pts: 42n,
        isConfig: false,
        isKey: true,
      });
    },
  );
});

test("clean EOF when stream ends before a header (read after end)", async () => {
  const { s, r } = makeReader();
  s.emit("end");
  const err = await r.read(12, "header").catch((e) => e);
  expect(err).toBeInstanceOf(ScrcpyStreamError);
  expect(err.code).toBe("clean-eof");
});

test("overflow destroys reader and cannot resume", async () => {
  const { s, r } = makeReader();
  s.emit("data", Buffer.allocUnsafe(33 * 1024 * 1024));
  const err = await r.read(4, "header").catch((e) => e);
  expect(err.code).toBe("reader-overflow");
  expect(s.destroyed).toBe(true);
  s.emit("data", Buffer.of(1, 2, 3, 4));
  const err2 = await r.read(4, "header").catch((e) => e);
  expect(err2.code).toBe("reader-overflow");
});

// The server maps readFrame's result to a terminal status: null → "stopped"
// (clean shutdown), thrown ScrcpyStreamError → "error" with code/meta.
describe("readFrame terminal mapping", () => {
  test("clean EOF at a frame boundary returns null (→ status 'stopped')", async () => {
    const { s, r } = makeReader();
    s.emit("end");
    expect(await readFrame(r, 4)).toBeNull();
  });

  test("truncated header throws truncated-header (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", Buffer.alloc(6));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-header");
  });

  test("truncated payload throws truncated-payload (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 100 }));
    s.emit("data", Buffer.alloc(40));
    s.emit("end");
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("truncated-payload");
    expect(err.meta).toEqual({ needed: 100, had: 40 });
  });

  test("zero-size frame header throws invalid-frame-size (→ status 'error')", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 0 }));
    const err = await readFrame(r, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ScrcpyStreamError);
    expect(err.code).toBe("invalid-frame-size");
  });

  test("a complete frame is parsed and returned", async () => {
    const { s, r } = makeReader();
    s.emit("data", frameHeader(4, { size: 4, key: true }));
    s.emit("data", Buffer.of(1, 2, 3, 4));
    const f = await readFrame(r, 4);
    expect(f?.type).toBe("frame");
    if (f?.type === "frame") {
      expect(f.isKey).toBe(true);
      expect(f.data).toEqual(Buffer.of(1, 2, 3, 4));
    }
  });
});
