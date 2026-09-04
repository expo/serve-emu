import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
  createFfmpegAvailabilityProbe,
  FFMPEG_ENCODER_FOR_CODEC,
  FfmpegStderrTail,
  ffmpegInputArgs,
  ffmpegOutputArgs,
  H264Encoder,
  H264OutputParser,
  isVpxKeyFrame,
  IvfOutputParser,
  resolveFfmpeg,
  VideoEncoder,
  videoFilter,
  vp8ThreadCount,
  type H264EncoderOpts,
  type VideoCodec,
} from "../src/h264-encoder.ts";
import type { ExecResult } from "../src/exec.ts";
import type { VideoFrame } from "../src/scrcpy.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function execResult(
  overrides: Partial<ExecResult<string>> = {},
): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: " V..... libx264 H.264 / AVC / MPEG-4 AVC",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

function hasFfmpegEncoder(codec: VideoCodec): boolean {
  const result = spawnSync(resolveFfmpeg(), ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  });
  return (
    result.status === 0 &&
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(
      FFMPEG_ENCODER_FOR_CODEC[codec],
    )
  );
}

const realFfmpegTest = hasFfmpegEncoder("h264") ? test : test.skip;
const realVpxFfmpegTest: Record<"vp8" | "vp9", typeof test> = {
  vp8: hasFfmpegEncoder("vp8") ? test : test.skip,
  vp9: hasFfmpegEncoder("vp9") ? test : test.skip,
};

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
    const end = Math.min(
      stream.length,
      offset + widths[index % widths.length]!,
    );
    parser.push(stream.subarray(offset, end));
    offset = end;
    index++;
  }
}

function ivfHeader(codec: "vp8" | "vp9", headerBytes = 32): Buffer {
  const header = Buffer.alloc(headerBytes);
  header.write("DKIF", 0, "ascii");
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(headerBytes, 6);
  header.write(codec === "vp8" ? "VP80" : "VP90", 8, "ascii");
  header.writeUInt16LE(16, 12);
  header.writeUInt16LE(16, 14);
  header.writeUInt32LE(30, 16);
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(0xffff_ffff, 24);
  return header;
}

function ivfFrame(data: Buffer, timestamp: bigint): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(data.length, 0);
  header.writeBigUInt64LE(timestamp, 4);
  return Buffer.concat([header, data]);
}

function pushIvfInUnevenChunks(parser: IvfOutputParser, stream: Buffer): void {
  const widths = [31, 1, 3, 9, 2, 17, 5];
  let offset = 0;
  let index = 0;
  while (offset < stream.length) {
    const end = Math.min(
      stream.length,
      offset + widths[index % widths.length]!,
    );
    parser.push(stream.subarray(offset, end));
    offset = end;
    index++;
  }
}

describe("H264OutputParser", () => {
  test("emits current VideoFrame objects across split and mixed Annex-B start codes", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
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
    expect(frames[1]!.data.subarray(0, 5)).toEqual(
      Buffer.from([0, 0, 0, 1, 0x65]),
    );
  });

  test("does not duplicate a NAL when a chunk ends inside its four-byte start code", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
    parser.enqueuePts(1n);

    const stream = Buffer.concat([aud(), nal(0x65, [0x01, 0x02]), aud()]);
    // Nine bytes lands immediately after the IDR start code, forcing the
    // overlap scan to encounter its embedded three-byte start code.
    parser.push(stream.subarray(0, 9));
    parser.push(stream.subarray(9));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ isKey: true, pts: 1n });
    expect(frames[0]!.data).toEqual(nal(0x65, [0x01, 0x02]));
  });

  test("holds the final access unit until the following AUD and de-duplicates config", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 30,
      onFrame: (frame) => frames.push(frame),
    });
    parser.enqueuePts(1n);
    parser.enqueuePts(2n);

    const configAndIdr = [
      nal(0x67, [0x42, 0x00, 0x1f]),
      nal(0x68, [0xce, 0x06]),
      nal(0x65, [0x01]),
    ];
    parser.push(
      Buffer.concat([aud(), ...configAndIdr, aud(), ...configAndIdr]),
    );
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.isConfig)).toEqual([true, false]);

    parser.push(aud());
    expect(frames).toHaveLength(3);
    expect(frames.filter((frame) => frame.isConfig)).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      pts: 2n,
      isKey: true,
      type: "frame",
    });
  });

  test("uses the configured frame duration when ffmpeg produces an unmatched access unit", () => {
    const frames: VideoFrame[] = [];
    const parser = new H264OutputParser({
      fps: 60,
      onFrame: (frame) => frames.push(frame),
    });
    parser.push(
      Buffer.concat([aud(), nal(0x41, [1]), aud(), nal(0x41, [2]), aud()]),
    );

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

describe("IvfOutputParser", () => {
  const vp8Key = Buffer.from([
    0xf0, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00,
  ]);
  const vp8Delta = Buffer.from([0xb1, 0x01, 0x00, 0x05]);
  const vp9Key = Buffer.from([0x82, 0x49, 0x83, 0x42]);
  const vp9Delta = Buffer.from([0x86, 0x00, 0x40, 0x92]);

  test("recognizes VP8 and VP9 keyframe headers", () => {
    expect(isVpxKeyFrame("vp8", vp8Key)).toBe(true);
    expect(isVpxKeyFrame("vp8", vp8Delta)).toBe(false);
    expect(isVpxKeyFrame("vp8", Buffer.from([0, 0, 0, 1, 2, 3]))).toBe(
      false,
    );
    expect(isVpxKeyFrame("vp9", vp9Key)).toBe(true);
    expect(isVpxKeyFrame("vp9", vp9Delta)).toBe(false);
    expect(isVpxKeyFrame("vp9", Buffer.from([0x8a]))).toBe(false);
    expect(isVpxKeyFrame("vp9", Buffer.from([0xb0, 0, 0]))).toBe(true);
    expect(isVpxKeyFrame("vp9", Buffer.from([0xb8, 0, 0]))).toBe(false);
  });

  for (const { codec, key, delta } of [
    { codec: "vp8" as const, key: vp8Key, delta: vp8Delta },
    { codec: "vp9" as const, key: vp9Key, delta: vp9Delta },
  ]) {
    test(`unwraps split ${codec.toUpperCase()} IVF frames and preserves submitted PTS`, () => {
      const frames: VideoFrame[] = [];
      const parser = new IvfOutputParser({
        codec,
        fps: 30,
        onFrame: (frame) => frames.push(frame),
      });
      parser.enqueuePts(10_000n);
      parser.enqueuePts(20_000n);
      pushIvfInUnevenChunks(
        parser,
        Buffer.concat([
          ivfHeader(codec, 40),
          ivfFrame(key, 100n),
          ivfFrame(delta, 200n),
        ]),
      );

      expect(frames).toEqual([
        {
          type: "frame",
          data: key,
          pts: 10_000n,
          isConfig: false,
          isKey: true,
        },
        {
          type: "frame",
          data: delta,
          pts: 20_000n,
          isConfig: false,
          isKey: false,
        },
      ]);
    });
  }

  test("uses configured frame duration when IVF output has no submitted PTS", () => {
    const frames: VideoFrame[] = [];
    const parser = new IvfOutputParser({
      codec: "vp8",
      fps: 30,
      onFrame: (frame) => frames.push(frame),
    });
    parser.push(
      Buffer.concat([
        ivfHeader("vp8"),
        ivfFrame(vp8Key, 0n),
        ivfFrame(vp8Delta, 1n),
      ]),
    );
    expect(frames.map((frame) => frame.pts)).toEqual([33_333n, 66_666n]);
  });

  test("rejects malformed, mismatched, and oversized IVF structures", () => {
    const create = (codec: "vp8" | "vp9" = "vp8") =>
      new IvfOutputParser({ codec, fps: 30, onFrame: () => {} });

    expect(() => create().push(Buffer.alloc(32))).toThrow(
      "invalid IVF signature",
    );

    const badVersion = ivfHeader("vp8");
    badVersion.writeUInt16LE(1, 4);
    expect(() => create().push(badVersion)).toThrow(
      "unsupported IVF version 1",
    );

    expect(() => create("vp9").push(ivfHeader("vp8"))).toThrow(
      "IVF codec mismatch",
    );

    const oversizedHeader = ivfHeader("vp8");
    oversizedHeader.writeUInt16LE(4_097, 6);
    expect(() => create().push(oversizedHeader)).toThrow(
      "invalid IVF header length 4097",
    );

    const invalidFrame = Buffer.alloc(12);
    invalidFrame.writeUInt32LE(64 * 1024 * 1024, 0);
    expect(() =>
      create().push(Buffer.concat([ivfHeader("vp8"), invalidFrame])),
    ).toThrow("invalid IVF frame size");
  });

  test("validates parser codec, timing, and timestamps", () => {
    expect(() =>
      new IvfOutputParser({
        codec: "h264" as never,
        fps: 30,
        onFrame: () => {},
      }),
    ).toThrow("IVF does not support codec h264");
    expect(() =>
      new IvfOutputParser({ codec: "vp8", fps: 0, onFrame: () => {} }),
    ).toThrow("fps must be greater than 0");
    const parser = createIvfParser();
    expect(() => parser.enqueuePts(-1n)).toThrow("non-negative bigint");
  });
});

function createIvfParser(): IvfOutputParser {
  return new IvfOutputParser({
    codec: "vp8",
    fps: 30,
    onFrame: () => {},
  });
}

describe("ffmpeg availability probe", () => {
  test("runs asynchronously in the background and caches a successful binary", async () => {
    const completion = deferred<ExecResult<string>>();
    const calls: Array<{
      binary: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const probe = createFfmpegAvailabilityProbe({
      resolveBinary: () => "test-ffmpeg",
      runExec: (binary, args, options) => {
        calls.push({ binary, args, options });
        return completion.promise;
      },
    });

    let settled = false;
    const first = probe().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toEqual([
      {
        binary: "test-ffmpeg",
        args: ["-hide_banner", "-encoders"],
        options: {
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
          signal: undefined,
          lane: "background",
        },
      },
    ]);

    completion.resolve(execResult());
    await first;
    await probe();
    expect(calls).toHaveLength(1);
  });

  test("probes and caches each selected codec independently", async () => {
    const calls: string[] = [];
    const probe = createFfmpegAvailabilityProbe({
      resolveBinary: () => "test-ffmpeg",
      runExec: async () => {
        calls.push("encoders");
        return execResult({
          stdout: [
            " V..... libx264 H.264",
            " V..... libvpx VP8",
            " V..... libvpx-vp9 VP9",
          ].join("\n"),
        });
      },
    });

    await probe("vp8");
    await probe("vp8");
    await probe("vp9");
    await probe();
    expect(calls).toHaveLength(3);
  });

  test("passes cancellation to the process and does not cache an aborted probe", async () => {
    const calls: AbortSignal[] = [];
    const probe = createFfmpegAvailabilityProbe({
      resolveBinary: () => "test-ffmpeg",
      runExec: async (_binary, _args, options) => {
        const signal = options.signal!;
        calls.push(signal);
        if (calls.length > 1) return execResult();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return execResult({
          status: null,
          error: new Error("command was aborted"),
        });
      },
    });
    const controller = new AbortController();
    const reason = new Error("source switch cancelled startup");
    const first = probe(controller.signal);

    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(probe()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(controller.signal);
  });

  test("keeps actionable binary and libx264 failures", async () => {
    const missing = createFfmpegAvailabilityProbe({
      resolveBinary: () => "/missing/ffmpeg",
      runExec: async () =>
        execResult({
          status: null,
          error: new Error("spawn /missing/ffmpeg ENOENT"),
        }),
    });
    await expect(missing()).rejects.toThrow(
      'ffmpeg not found or unusable (tried "/missing/ffmpeg"): spawn /missing/ffmpeg ENOENT',
    );

    const missingX264 = createFfmpegAvailabilityProbe({
      resolveBinary: () => "ffmpeg-without-x264",
      runExec: async () => execResult({ stdout: " V..... h264_videotoolbox" }),
    });
    await expect(missingX264()).rejects.toThrow(
      'ffmpeg at "ffmpeg-without-x264" does not include the libx264 encoder',
    );

    const missingVp9 = createFfmpegAvailabilityProbe({
      resolveBinary: () => "ffmpeg-without-vp9",
      runExec: async () => execResult(),
    });
    await expect(missingVp9("vp9")).rejects.toThrow(
      'ffmpeg at "ffmpeg-without-vp9" does not include the libvpx-vp9 encoder required for VP9',
    );
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
    expect(() =>
      new VideoEncoder({
        ...valid,
        codec: "av1" as VideoCodec,
      }),
    ).toThrow("unsupported video codec av1");
  });

  test("reports transposed output dimensions for quarter-turn encoding", async () => {
    const encoder = new H264Encoder({
      ...valid,
      width: 576,
      height: 1280,
      quarterTurn: 1,
    });

    expect({
      width: encoder.encodedWidth,
      height: encoder.encodedHeight,
    }).toEqual({ width: 1280, height: 576 });

    await encoder.close();
  });

  test("maps Android quarter turns to ffmpeg rotation filters", () => {
    const crop = "crop=trunc(iw/2)*2:trunc(ih/2)*2";
    expect(videoFilter(0)).toBe(crop);
    expect(videoFilter(1)).toBe(`${crop},transpose=cclock`);
    expect(videoFilter(2)).toBe(`${crop},hflip,vflip`);
    expect(videoFilter(3)).toBe(`${crop},transpose=clock`);
  });

  test("selects fixed rawvideo or framed PNG input without changing output timing", () => {
    expect(ffmpegInputArgs("rgb24", 360, 640, 30)).toEqual([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-video_size",
      "360x640",
      "-framerate",
      "30",
      "-i",
      "pipe:0",
    ]);
    expect(ffmpegInputArgs("png", 360, 640, 30)).toEqual([
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-max_probe_packets",
      "1",
      "-f",
      "image2pipe",
      "-framerate",
      "30",
      "-c:v",
      "png",
      "-i",
      "pipe:0",
    ]);
  });

  test("selects codec-specific low-latency FFmpeg output", () => {
    const base = {
      fps: 60,
      bitRate: 8_000_000,
      keyFrameInterval: 10,
      encodedWidth: 436,
      encodedHeight: 980,
      parallelism: 8,
    };
    const h264 = ffmpegOutputArgs({ codec: "h264", ...base });
    expect(h264.join(" ")).toContain(
      "-c:v libx264 -preset ultrafast -tune zerolatency",
    );
    expect(h264.join(" ")).toContain("-f h264");
    expect(h264.join(" ")).toContain(
      "keyint=600:min-keyint=600:scenecut=0:repeat-headers=1:aud=1",
    );

    const vp8 = ffmpegOutputArgs({ codec: "vp8", ...base });
    expect(vp8.join(" ")).toContain(
      "-c:v libvpx -threads 3 -deadline realtime -cpu-used 16 -static-thresh 1000 -lag-in-frames 0 -auto-alt-ref 0 -error-resilient 1 -g 600",
    );
    expect(vp8.join(" ")).toContain("-f ivf -flush_packets 1");

    const vp9 = ffmpegOutputArgs({ codec: "vp9", ...base });
    expect(vp9.join(" ")).toContain(
      "-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 -auto-alt-ref 0 -error-resilient 1 -g 600",
    );
    expect(vp9.join(" ")).not.toContain("-threads");
    expect(vp9.join(" ")).not.toContain("-static-thresh");
    expect(vp9.join(" ")).toContain("-f ivf -flush_packets 1");
  });

  test.each([
    { width: 640, height: 480, parallelism: 8, expected: 1 },
    { width: 436, height: 980, parallelism: 8, expected: 3 },
    { width: 436, height: 980, parallelism: 3, expected: 2 },
    { width: 1281, height: 961, parallelism: 6, expected: 3 },
    { width: 1920, height: 1080, parallelism: 9, expected: 8 },
  ])(
    "selects $expected VP8 thread(s) for width=$width height=$height parallelism=$parallelism",
    ({ width, height, parallelism, expected }) => {
      expect(vp8ThreadCount(width, height, parallelism)).toBe(expected);
    },
  );

  test("validates PNG frame boundaries before writing to ffmpeg", async () => {
    const encoder = new H264Encoder({
      ...valid,
      inputFormat: "png",
    });
    expect(() => encoder.write(Buffer.from("not a png"), 1n)).toThrow(
      "complete PNG Buffer",
    );
    await encoder.close();
  });

  realFfmpegTest(
    "accepts concatenated PNG images through image2pipe",
    async () => {
      const generated = spawnSync(
        resolveFfmpeg(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=128x128",
          "-frames:v",
          "1",
          "-c:v",
          "png",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        { encoding: null },
      );
      expect(generated.status).toBe(0);
      const png = Buffer.from(generated.stdout);
      const frames: VideoFrame[] = [];
      let resolveKeyFrame!: () => void;
      let rejectKeyFrame!: (error: Error) => void;
      const keyFrame = new Promise<void>((resolve, reject) => {
        resolveKeyFrame = resolve;
        rejectKeyFrame = reject;
      });
      const encoder = new H264Encoder({
        ...valid,
        width: 128,
        height: 128,
        inputFormat: "png",
        onFrame(frame) {
          frames.push(frame);
          if (frame.isKey) resolveKeyFrame();
        },
        onExit(reason) {
          rejectKeyFrame(new Error(reason));
        },
      });

      // Keep enough framed input in the pipe for libavformat's initial stream
      // probe; real emulator PNGs are substantially larger than this fixture.
      for (let index = 0; index < 20; index++) {
        expect(encoder.write(png, BigInt(index + 1))).toBe(true);
      }
      await Promise.race([
        keyFrame,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for ffmpeg")),
            2_000,
          ),
        ),
      ]);
      await encoder.close();
      expect(frames.some((frame) => frame.isConfig)).toBe(true);
      expect(frames.some((frame) => frame.isKey)).toBe(true);
    },
  );

  for (const codec of ["vp8", "vp9"] as const) {
    realVpxFfmpegTest[codec](
      `emits raw ${codec.toUpperCase()} frames from real FFmpeg IVF output`,
      async () => {
        const width = 16;
        const height = 16;
        const frames: VideoFrame[] = [];
        let resolveFrames!: () => void;
        let rejectFrames!: (error: Error) => void;
        const framesReady = new Promise<void>((resolve, reject) => {
          resolveFrames = resolve;
          rejectFrames = reject;
        });
        const encoder = new VideoEncoder({
          codec,
          width,
          height,
          fps: 30,
          bitRate: 1_000_000,
          keyFrameInterval: 10,
          onFrame(frame) {
            frames.push(frame);
            if (frames.length >= 2) resolveFrames();
          },
          onExit(reason) {
            rejectFrames(new Error(reason));
          },
        });

        try {
          for (let index = 0; index < 4; index++) {
            const rgb = Buffer.alloc(width * height * 3, index * 40);
            expect(encoder.write(rgb, BigInt((index + 1) * 1_000))).toBe(true);
          }
          await Promise.race([
            framesReady,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`timed out waiting for ${codec}`)),
                3_000,
              ),
            ),
          ]);
        } finally {
          await encoder.close();
        }

        expect(frames.length).toBeGreaterThanOrEqual(2);
        expect(frames[0]).toMatchObject({
          pts: 1_000n,
          isConfig: false,
          isKey: true,
        });
        expect(frames[1]).toMatchObject({
          pts: 2_000n,
          isConfig: false,
          isKey: false,
        });
        expect(frames[0]!.data.subarray(0, 4).toString("ascii")).not.toBe(
          "DKIF",
        );
      },
    );
  }

  realFfmpegTest(
    "applies Android quarter-turn direction to encoded pixels",
    async () => {
      // Keep both encoded dimensions at least one H.264 macroblock so this
      // real-ffmpeg test behaves consistently across libx264 builds.
      const width = 16;
      const height = 32;
      const rgb = Buffer.alloc(width * height * 3);
      const colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
      ];
      for (let y = 0; y < height; y++) {
        const color = colors[Math.floor(y / (height / colors.length))]!;
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 3;
          rgb[offset] = color[0]!;
          rgb[offset + 1] = color[1]!;
          rgb[offset + 2] = color[2]!;
        }
      }

      let config: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let keyFrame: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let resolveKeyFrame!: () => void;
      let rejectKeyFrame!: (reason?: unknown) => void;
      const keyFrameReady = new Promise<void>((resolve, reject) => {
        resolveKeyFrame = resolve;
        rejectKeyFrame = reject;
      });
      const encoder = new H264Encoder({
        ...valid,
        width,
        height,
        quarterTurn: 1,
        onFrame(frame) {
          if (frame.isConfig) config = frame.data;
          else if (frame.isKey && keyFrame.length === 0) {
            keyFrame = frame.data;
            resolveKeyFrame();
          }
        },
        onExit(reason) {
          rejectKeyFrame(new Error(reason));
        },
      });
      encoder.write(rgb, 1n);
      encoder.write(rgb, 2n);
      await Promise.race([
        keyFrameReady,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for ffmpeg")),
            2_000,
          ),
        ),
      ]);
      await encoder.close();

      const decoded = spawnSync(
        resolveFfmpeg(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "h264",
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { input: Buffer.concat([config, keyFrame]) },
      );
      expect(decoded.status).toBe(0);

      const topRow = colors.map((_, index) => {
        const x = index * (height / colors.length);
        const offset = x * 3;
        return [...decoded.stdout.subarray(offset, offset + 3)];
      });
      expect(topRow).toEqual([
        expect.arrayContaining([expect.any(Number), 0, 0]),
        expect.arrayContaining([0, expect.any(Number), 0]),
        expect.arrayContaining([0, 0, expect.any(Number)]),
        expect.arrayContaining([
          expect.any(Number),
          expect.any(Number),
          expect.any(Number),
        ]),
      ]);
      expect(topRow[0]![0]).toBeGreaterThan(200);
      expect(topRow[1]![1]).toBeGreaterThan(200);
      expect(topRow[2]![2]).toBeGreaterThan(200);
      expect(Math.min(...topRow[3]!)).toBeGreaterThan(200);
    },
  );
});

describe("ffmpeg diagnostics", () => {
  test("retains a bounded stderr tail for exit failures", () => {
    const stderr = new FfmpegStderrTail();
    stderr.append(Buffer.from(`discarded:${"x".repeat(20_000)}`));
    stderr.append(Buffer.from(":actionable failure\n"));

    expect(Buffer.byteLength(stderr.text())).toBeLessThanOrEqual(16 * 1024);
    expect(stderr.text()).not.toContain("discarded:");
    expect(stderr.text()).toEndWith(":actionable failure");
  });
});
