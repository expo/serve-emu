import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
  dispatch,
  resetVideoPacket,
  type DispatchSleep,
  type Gesture,
} from "../src/input.ts";
import { SCRCPY_VERSION } from "../scripts/fetch-scrcpy.ts";

const SCREEN = { width: 100, height: 200 };

class CaptureSocket {
  readonly writes: Buffer[] = [];

  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    return true;
  }
}

function golden(value: string): string {
  return value.replaceAll(/\s/g, "");
}

async function encode(gesture: Gesture): Promise<{
  packets: string[];
  delays: number[];
}> {
  const socket = new CaptureSocket();
  const delays: number[] = [];
  const sleep: DispatchSleep = async (ms) => {
    delays.push(ms);
  };
  await dispatch(socket as unknown as Socket, gesture, SCREEN, sleep);
  return {
    packets: socket.writes.map((packet) => packet.toString("hex")),
    delays,
  };
}

describe("scrcpy control packet goldens", () => {
  test("fixtures are pinned to the vendored scrcpy 4.0 protocol", () => {
    expect(SCRCPY_VERSION).toBe("4.0");
  });

  test("tap writes exact down/up packets with an injectable delay", async () => {
    const result = await encode({ type: "tap", x: 0.25, y: 0.5 });
    expect(result).toEqual({
      packets: [
        golden("02 00 0000000000000000 00000019 00000064 0064 00c8 ffff 00000001 00000001"),
        golden("02 01 0000000000000000 00000019 00000064 0064 00c8 0000 00000001 00000000"),
      ],
      delays: [20],
    });
  });

  test("touch writes the exact action, pointer, position, and screen", async () => {
    const result = await encode({
      type: "touch",
      action: "move",
      x: 0.1,
      y: 0.2,
      pointerId: 7,
    });
    expect(result).toEqual({
      packets: [
        golden("02 02 0000000000000007 0000000a 00000028 0064 00c8 ffff 00000001 00000001"),
      ],
      delays: [],
    });
  });

  test("key writes exact down/up packets including meta state", async () => {
    const result = await encode({ type: "key", keycode: 66, metaState: 3 });
    expect(result).toEqual({
      packets: [
        golden("00 00 00000042 00000000 00000003"),
        golden("00 01 00000042 00000000 00000003"),
      ],
      delays: [],
    });
  });

  test("text writes an exact UTF-8 length-prefixed packet", async () => {
    const result = await encode({ type: "text", text: "A😀" });
    expect(result).toEqual({
      packets: [golden("01 00000005 41 f09f9880")],
      delays: [],
    });
  });

  test("text truncation never splits a UTF-8 code point", async () => {
    const result = await encode({
      type: "text",
      text: `${"a".repeat(299)}😀tail`,
    });
    const packet = Buffer.from(result.packets[0], "hex");
    expect(packet.readUInt32BE(1)).toBe(299);
    expect(packet.subarray(5).toString("utf8")).toBe("a".repeat(299));
    expect(packet).toHaveLength(304);
  });

  test.each([
    {
      name: "back",
      gesture: { type: "back" } as const,
      packets: ["04 00", "04 01"],
    },
    {
      name: "home",
      gesture: { type: "home" } as const,
      packets: [
        "00 00 00000003 00000000 00000000",
        "00 01 00000003 00000000 00000000",
      ],
    },
    {
      name: "recents",
      gesture: { type: "recents" } as const,
      packets: [
        "00 00 000000bb 00000000 00000000",
        "00 01 000000bb 00000000 00000000",
      ],
    },
    {
      name: "power",
      gesture: { type: "power" } as const,
      packets: [
        "00 00 0000001a 00000000 00000000",
        "00 01 0000001a 00000000 00000000",
      ],
    },
  ])("$name writes exact navigation packets", async ({ gesture, packets }) => {
    const result = await encode(gesture);
    expect(result).toEqual({
      packets: packets.map(golden),
      delays: [],
    });
  });

  test("reset-video is the exact one-byte control packet", () => {
    expect(resetVideoPacket().toString("hex")).toBe("11");
  });

  test("swipe writes a deterministic golden packet plan", async () => {
    const result = await encode({
      type: "swipe",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      durationMs: 80,
    });
    expect(result).toEqual({
      packets: [
        golden("02 00 0000000000000000 00000000 00000000 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 0000000d 00000019 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 00000019 00000032 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 00000026 0000004b 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 00000032 00000064 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 0000003f 0000007d 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 0000004b 00000096 0064 00c8 ffff 00000001 00000001"),
        golden("02 02 0000000000000000 00000058 000000af 0064 00c8 ffff 00000001 00000001"),
        golden("02 01 0000000000000000 00000064 000000c8 0064 00c8 0000 00000001 00000000"),
      ],
      delays: [10, 10, 10, 10, 10, 10, 10, 10],
    });
  });
});
