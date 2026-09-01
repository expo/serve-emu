import { describe, expect, test } from "bun:test";
import {
  H264Encoder,
  H264OutputParser,
  type H264EncoderOpts,
} from "../src/h264-encoder.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

function nal(
  typeByte: number,
  payload: number[] = [],
  startCodeBytes: 3 | 4 = 4,
): Buffer {
  const start = startCodeBytes === 3 ? [0, 0, 1] : [0, 0, 0, 1];
  return Buffer.from([...start, typeByte, ...payload]);
}

function aud(startCodeBytes: 3 | 4 = 4): Buffer {
  return nal(0x09, [0xf0], startCodeBytes);
}

function pushInUnevenChunks(parser: H264OutputParser, stream: Buffer): void {
  const widths = [1, 2, 7, 3, 11, 5];
  let offset = 0;
  let index = 0;
  while (offset < stream.length) {
    const end = Math.min(stream.length, offset + widths[index % widths.length]!);
    parser.push(stream.subarray(offset, end));
    offset = end;
    index++;
  }
}

describe("H264OutputParser", () => {
  test("emits current VideoFrame objects across split and mixed Annex-B start codes", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({ fps: 60, onFrame: (frame) => frames.push(frame) });
    parser.enqueuePts(10_000n);
    parser.enqueuePts(20_000n);

    const stream = Buffer.concat([
      aud(3),
      nal(0x67, [0x42, 0x00, 0x1f], 4),
      nal(0x68, [0xce, 0x06], 3),
      nal(0x65, [0xaa, 0xbb], 4),
      aud(4),
      nal(0x41, [0xcc], 3),
      aud(3),
    ]);
    pushInUnevenChunks(parser, stream);

    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      type: "frame",
      pts: 0n,
      isConfig: true,
      isKey: false,
    });
    expect(frames[1]).toMatchObject({
      type: "frame",
      pts: 10_000n,
      isConfig: false,
      isKey: true,
    });
    expect(frames[2]).toMatchObject({
      type: "frame",
      pts: 20_000n,
      isConfig: false,
      isKey: false,
    });
    expect(frames[0]!.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(frames[1]!.data.subarray(0, 5)).toEqual(Buffer.from([0, 0, 0, 1, 0x65]));
  });

  test("holds the final access unit until the following AUD and de-duplicates config", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({ fps: 30, onFrame: (frame) => frames.push(frame) });
    parser.enqueuePts(1n);
    parser.enqueuePts(2n);

    const configAndIdr = [
      nal(0x67, [0x42, 0x00, 0x1f]),
      nal(0x68, [0xce, 0x06]),
      nal(0x65, [0x01]),
    ];
    parser.push(Buffer.concat([aud(), ...configAndIdr, aud(), ...configAndIdr]));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.isConfig)).toEqual([true, false]);

    parser.push(aud());
    expect(frames).toHaveLength(3);
    expect(frames.filter((frame) => frame.isConfig)).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ pts: 2n, isKey: true, type: "frame" });
  });

  test("uses the configured frame duration when ffmpeg produces an unmatched access unit", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({ fps: 60, onFrame: (frame) => frames.push(frame) });
    parser.push(Buffer.concat([
      aud(),
      nal(0x41, [1]),
      aud(),
      nal(0x41, [2]),
      aud(),
    ]));

    expect(frames.map((frame) => frame.pts)).toEqual([16_667n, 33_334n]);
  });

  test("rejects invalid parser timing and timestamps", () => {
    expect(() => new H264OutputParser({ fps: 0, onFrame: () => {} })).toThrow(
      "fps must be greater than 0",
    );
    const parser = new H264OutputParser({ fps: 60, onFrame: () => {} });
    expect(() => parser.enqueuePts(-1n)).toThrow("non-negative bigint");
  });
});

describe("H264Encoder validation", () => {
  const valid: H264EncoderOpts = {
    width: 576,
    height: 1280,
    fps: 60,
    bitRate: 8_000_000,
    keyFrameInterval: 10,
    onFrame: () => {},
    onExit: () => {},
  };

  test("rejects invalid dimensions before starting ffmpeg", () => {
    expect(() => new H264Encoder({ ...valid, width: 1 })).toThrow(
      "at least 2 pixels",
    );
    expect(() => new H264Encoder({ ...valid, height: 1.5 })).toThrow(
      "safe integer",
    );
    expect(() => new H264Encoder({ ...valid, width: 16_385 })).toThrow(
      "at most 16384",
    );
  });

  test("rejects invalid frame and rate settings before starting ffmpeg", () => {
    expect(() => new H264Encoder({ ...valid, fps: 0 })).toThrow(
      "fps must be greater than 0",
    );
    expect(() => new H264Encoder({ ...valid, bitRate: 0 })).toThrow(
      "bitRate must be greater than 0",
    );
    expect(() => new H264Encoder({ ...valid, keyFrameInterval: -1 })).toThrow(
      "non-negative",
    );
  });
});
