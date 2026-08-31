import { describe, expect, test } from "bun:test";
import { parseIceUrlList, redactedStreamSettings } from "../src/stream-settings.ts";

describe("stream settings", () => {
  test("parses comma-separated STUN and TURN URLs", () => {
    expect(parseIceUrlList("stun:one.example:3478, stuns:two.example:5349", "stun")).toEqual([
      "stun:one.example:3478",
      "stuns:two.example:5349",
    ]);
    expect(parseIceUrlList("turn:turn.example:3478?transport=udp", "turn")).toEqual([
      "turn:turn.example:3478?transport=udp",
    ]);
  });

  test("rejects ICE URLs with the wrong scheme", () => {
    expect(() => parseIceUrlList("https://example.test", "stun")).toThrow(
      "Expected one or more comma-separated STUN URLs",
    );
    expect(() => parseIceUrlList("stun:stun.example:3478", "turn")).toThrow(
      "Expected one or more comma-separated TURN URLs",
    );
  });

  test("redacts TURN credentials in stream-health output", () => {
    expect(
      redactedStreamSettings({
        transport: "webrtc",
        codec: "h264",
        iceTransportPolicy: "all",
        iceServers: [
          {
            urls: ["turn:turn.example:3478"],
            username: "user",
            credential: "secret",
          },
        ],
      }),
    ).toEqual({
      transport: "webrtc",
      codec: "h264",
      iceTransportPolicy: "all",
      iceServers: [
        {
          urls: ["turn:turn.example:3478"],
          username: "user",
          credential: "redacted",
        },
      ],
    });
  });
});
