import { describe, expect, test } from "bun:test";
import { SCRCPY_SERVER_SHA256, SCRCPY_VERSION, verifyScrcpyServer } from "../scrcpy-server.ts";

describe("scrcpy server integrity", () => {
  test("pins a SHA-256 digest for the vendored server", () => {
    expect(SCRCPY_VERSION).toBe("4.0");
    expect(SCRCPY_SERVER_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects bytes that do not match the pinned server", () => {
    expect(() => verifyScrcpyServer(new TextEncoder().encode("not scrcpy"))).toThrow(
      "checksum mismatch",
    );
  });
});
