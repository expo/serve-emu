import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCameraImage,
  assertCameraSupported,
  cameraFeedPath,
  cameraFeedRoot,
  cameraLaunchArgs,
  clearCameraImage,
  MAX_CAMERA_IMAGE_BYTES,
  parseCameraFacing,
  placeholderCameraImage,
  readCameraFeed,
  readCameraStatus,
  seedCameraFeeds,
  setCameraImage,
} from "../src/camera.ts";
import { headerOnlyPng, solidPng } from "./fixtures/png.ts";

async function stagingFiles(): Promise<string[]> {
  return (await readdir(cameraFeedRoot())).filter((name) => name.endsWith(".tmp"));
}

let root: string;
const previousRoot = process.env.SERVE_EMU_CAMERA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serve-emu-camera-test-"));
  process.env.SERVE_EMU_CAMERA_DIR = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.SERVE_EMU_CAMERA_DIR;
  else process.env.SERVE_EMU_CAMERA_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("camera feed paths", () => {
  test("derives one path per facing under the overridable root", () => {
    expect(cameraFeedRoot()).toBe(root);
    expect(cameraFeedPath("emulator-5554", "back")).toBe(
      join(root, "emulator-5554-back.png"),
    );
    expect(cameraFeedPath("emulator-5554", "front")).toBe(
      join(root, "emulator-5554-front.png"),
    );
  });

  test("keeps a hostile serial inside the feed directory", () => {
    expect(cameraFeedPath("../../etc/passwd", "back")).toBe(
      join(root, ".._.._etc_passwd-back.png"),
    );
  });

  test("emits the emulator flags that attach both feeds", () => {
    expect(cameraLaunchArgs("emulator-5554")).toEqual([
      "-camera-back",
      `imagefile:${join(root, "emulator-5554-back.png")}`,
      "-camera-front",
      `imagefile:${join(root, "emulator-5554-front.png")}`,
    ]);
  });
});

describe("camera input validation", () => {
  test("defaults to the back camera and rejects an unknown facing", () => {
    expect(parseCameraFacing(undefined)).toBe("back");
    expect(parseCameraFacing(null)).toBe("back");
    expect(parseCameraFacing("")).toBe("back");
    expect(parseCameraFacing("front")).toBe("front");
    expect(() => parseCameraFacing("selfie")).toThrow("facing must be one of");
  });

  test("reads the size out of a PNG header", () => {
    expect(assertCameraImage(placeholderCameraImage().png)).toEqual({
      width: 1280,
      height: 960,
    });
  });

  test("rejects a JPEG by naming the emulator's PNG-only constraint", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(32).fill(0)]);
    expect(() => assertCameraImage(jpeg)).toThrow("PNG only");
  });

  test("rejects a truncated PNG and an oversized body", () => {
    expect(() => assertCameraImage(placeholderCameraImage().png.subarray(0, 16))).toThrow(
      "must be a PNG",
    );
    expect(() =>
      assertCameraImage(new Uint8Array(MAX_CAMERA_IMAGE_BYTES + 1)),
    ).toThrow("exceeds");
  });

  test("rejects a PNG the emulator could not decode", () => {
    expect(() => assertCameraImage(headerOnlyPng(4000, 3000, 4096))).toThrow(
      "truncated",
    );

    const real = solidPng(8, 8, [10, 20, 30]);
    expect(() => assertCameraImage(real.subarray(0, real.length - 20))).toThrow(
      "truncated",
    );

    const corruptIdat = Buffer.from(real);
    corruptIdat[corruptIdat.length - 20] ^= 0xff;
    expect(() => assertCameraImage(corruptIdat)).toThrow("corrupt IDAT chunk");

    const noImageData = Buffer.concat([
      real.subarray(0, 8 + 25),
      real.subarray(real.length - 12),
    ]);
    expect(() => assertCameraImage(noImageData)).toThrow("no IDAT chunk");
  });

  test("accepts a decodable PNG built outside this module", () => {
    expect(assertCameraImage(solidPng(64, 48, [1, 2, 3]))).toEqual({
      width: 64,
      height: 48,
    });
  });

  test("rejects a PNG whose IHDR is missing or empty", () => {
    const renamed = Buffer.from(solidPng(8, 8, [0, 0, 0]));
    renamed.write("IDAT", 12, "ascii");
    expect(() => assertCameraImage(renamed)).toThrow("missing its IHDR header");

    const zeroed = Buffer.from(solidPng(8, 8, [0, 0, 0]));
    zeroed.writeUInt32BE(0, 16);
    expect(() => assertCameraImage(zeroed)).toThrow("zero dimensions");
  });

  test("refuses a physical device serial", () => {
    expect(() => assertCameraSupported("R3CN90ABCDE")).toThrow(
      "Android Emulator serials only",
    );
    expect(() => assertCameraSupported("emulator-5554")).not.toThrow();
  });
});

describe("camera feed writes", () => {
  test("reports an absent feed without inventing metadata", async () => {
    const feed = await readCameraFeed("emulator-5554", "back");
    expect(feed).toMatchObject({
      facing: "back",
      present: false,
      placeholder: false,
      width: null,
      digest: null,
      updatedAt: null,
    });
  });

  test("writes an image and reports its size and digest", async () => {
    const png = placeholderCameraImage().png;
    const feed = await setCameraImage("emulator-5554", "front", png);
    expect(feed).toMatchObject({
      facing: "front",
      present: true,
      placeholder: true,
      width: 1280,
      height: 960,
      bytes: png.byteLength,
      digest: placeholderCameraImage().digest,
    });
    expect(Uint8Array.from(await readFile(cameraFeedPath("emulator-5554", "front")))).toEqual(
      Uint8Array.from(png),
    );
  });

  test("leaves no staging file behind", async () => {
    await setCameraImage("emulator-5554", "back", placeholderCameraImage().png);
    expect(await stagingFiles()).toEqual([]);
  });

  test("concurrent writes to one facing publish one whole image, never a mixture", async () => {
    const variants = Array.from({ length: 8 }, (_, i) =>
      solidPng(120 + i * 40, 90 + i * 30, [i, 0x40 + i, 0x80 + i]),
    );
    await Promise.all(
      variants.map((png) => setCameraImage("emulator-5554", "back", png)),
    );

    const published = await readFile(cameraFeedPath("emulator-5554", "back"));
    expect(variants.some((variant) => variant.equals(published))).toBe(true);
    expect(await stagingFiles()).toEqual([]);
  });

  test("marks a caller-supplied image as not the placeholder", async () => {
    const feed = await setCameraImage("emulator-5554", "back", solidPng(640, 480, [9, 9, 9]));
    expect(feed.placeholder).toBe(false);
    expect(feed.width).toBe(640);
  });

  test("rejects a non-PNG without touching a live feed", async () => {
    const png = placeholderCameraImage().png;
    await setCameraImage("emulator-5554", "back", png);
    await expect(
      setCameraImage("emulator-5554", "back", Buffer.from("not a png at all!!!!!!!!")),
    ).rejects.toThrow("PNG only");
    expect(Uint8Array.from(await readFile(cameraFeedPath("emulator-5554", "back")))).toEqual(
      Uint8Array.from(png),
    );
  });

  test("clear restores the placeholder", async () => {
    await setCameraImage("emulator-5554", "back", solidPng(640, 480, [9, 9, 9]));
    expect((await readCameraFeed("emulator-5554", "back")).placeholder).toBe(false);
    expect((await clearCameraImage("emulator-5554", "back")).placeholder).toBe(true);
  });
});

describe("seedCameraFeeds", () => {
  test("gives every facing a parsable PNG", async () => {
    await seedCameraFeeds("emulator-5554");
    const status = await readCameraStatus("emulator-5554", true);
    expect(status.feeds.map((feed) => feed.facing)).toEqual(["back", "front"]);
    expect(status.feeds.every((feed) => feed.placeholder)).toBe(true);
  });

  test("replaces whatever an earlier run on this serial left behind", async () => {
    await setCameraImage("emulator-5554", "back", solidPng(640, 480, [7, 7, 7]));
    await seedCameraFeeds("emulator-5554");
    const feeds = await Promise.all(
      (["back", "front"] as const).map((facing) => readCameraFeed("emulator-5554", facing)),
    );
    expect(feeds.every((feed) => feed.placeholder)).toBe(true);
  });

  test("replaces a file the emulator could not parse", async () => {
    await Bun.write(cameraFeedPath("emulator-5554", "back"), "corrupt");
    await seedCameraFeeds("emulator-5554");
    expect((await readCameraFeed("emulator-5554", "back")).placeholder).toBe(true);
  });

  test("sweeps only this serial's leftover staging files", async () => {
    const ours = `${cameraFeedPath("emulator-5554", "back")}.abandoned.tmp`;
    const theirs = `${cameraFeedPath("emulator-5556", "back")}.abandoned.tmp`;
    await Bun.write(ours, "partial");
    await Bun.write(theirs, "partial");

    await seedCameraFeeds("emulator-5554");

    expect(await Bun.file(ours).exists()).toBe(false);
    expect(await Bun.file(theirs).exists()).toBe(true);
  });
});

describe("readCameraStatus", () => {
  test("reports support and wiring without guessing", async () => {
    await expect(readCameraStatus("emulator-5554", false)).resolves.toMatchObject({
      serial: "emulator-5554",
      supported: true,
      wiredAtLaunch: false,
    });
    await expect(readCameraStatus("R3CN90ABCDE", false)).resolves.toMatchObject({
      supported: false,
    });
  });

  test("reports a present file whose bytes are not a PNG", async () => {
    await writeFile(cameraFeedPath("emulator-5554", "back"), "still not a png");
    const [back] = (await readCameraStatus("emulator-5554", true)).feeds;
    expect(back).toMatchObject({ present: true, placeholder: false, width: null });
  });
});
