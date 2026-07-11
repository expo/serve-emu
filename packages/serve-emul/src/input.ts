import type { Socket } from "node:net";
import {
  parseGesture,
  type Gesture,
  type Screen,
} from "./shared/control-contracts.ts";

export {
  parseGesture,
  type Gesture,
  type Screen,
} from "./shared/control-contracts.ts";

// scrcpy v3 ControlMessage type codes
const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH = 2;
const TYPE_BACK_OR_SCREEN_ON = 4;
const TYPE_RESET_VIDEO = 17;

export function resetVideoPacket(): Buffer {
  return RESET_VIDEO_PACKET;
}

// Android KeyEvent action
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

// Common Android keycodes
const KEY = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  enter: 66,
} as const;

const PRIMARY_POINTER_ID = 0n;
const PRESSURE_FULL = 0xffff;
const BUTTON_PRIMARY = 1;
const RESET_VIDEO_PACKET = Buffer.from([TYPE_RESET_VIDEO]);

const MAX_TEXT_BYTES = 300;

function textBytes(text: string): Buffer {
  const out: string[] = [];
  let total = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (total + bytes > MAX_TEXT_BYTES) break;
    out.push(char);
    total += bytes;
  }
  return Buffer.from(out.join(""), "utf8");
}

function touchPacket(
  action: number,
  x: number,
  y: number,
  screen: Screen,
  pointerId = PRIMARY_POINTER_ID,
): Buffer {
  const buf = Buffer.allocUnsafe(32);
  let o = 0;
  buf.writeUInt8(TYPE_INJECT_TOUCH, o); o += 1;
  buf.writeUInt8(action, o); o += 1;
  buf.writeBigUInt64BE(pointerId, o); o += 8;
  buf.writeInt32BE(Math.round(x), o); o += 4;
  buf.writeInt32BE(Math.round(y), o); o += 4;
  buf.writeUInt16BE(screen.width, o); o += 2;
  buf.writeUInt16BE(screen.height, o); o += 2;
  buf.writeUInt16BE(action === ACTION_UP ? 0 : PRESSURE_FULL, o); o += 2;
  buf.writeUInt32BE(BUTTON_PRIMARY, o); o += 4;
  buf.writeUInt32BE(action === ACTION_UP ? 0 : BUTTON_PRIMARY, o); o += 4;
  return buf;
}

function keyPacket(action: number, keycode: number, metaState = 0): Buffer {
  const buf = Buffer.allocUnsafe(14);
  let o = 0;
  buf.writeUInt8(TYPE_INJECT_KEYCODE, o); o += 1;
  buf.writeUInt8(action, o); o += 1;
  buf.writeInt32BE(keycode, o); o += 4;
  buf.writeInt32BE(0, o); o += 4; // repeat
  buf.writeInt32BE(metaState, o); o += 4;
  return buf;
}

function textPacket(text: string): Buffer {
  const bytes = textBytes(text);
  const len = bytes.length;
  const buf = Buffer.allocUnsafe(5 + len);
  buf.writeUInt8(TYPE_INJECT_TEXT, 0);
  buf.writeUInt32BE(len, 1);
  bytes.copy(buf, 5);
  return buf;
}

function backOrScreenOnPacket(action: number): Buffer {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(TYPE_BACK_OR_SCREEN_ON, 0);
  buf.writeUInt8(action, 1);
  return buf;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function actionCode(a: "down" | "move" | "up"): number {
  return a === "down" ? ACTION_DOWN : a === "up" ? ACTION_UP : ACTION_MOVE;
}

export async function dispatch(control: Socket, g: Gesture, screen: Screen): Promise<void> {
  const px = (n: number) => n * screen.width;
  const py = (n: number) => n * screen.height;

  switch (g.type) {
    case "tap": {
      control.write(touchPacket(ACTION_DOWN, px(g.x), py(g.y), screen));
      await sleep(20);
      control.write(touchPacket(ACTION_UP, px(g.x), py(g.y), screen));
      return;
    }
    case "swipe": {
      const dur = Math.max(80, g.durationMs ?? 250);
      const steps = Math.max(8, Math.round(dur / 16));
      control.write(touchPacket(ACTION_DOWN, px(g.x1), py(g.y1), screen));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const x = px(g.x1 + (g.x2 - g.x1) * t);
        const y = py(g.y1 + (g.y2 - g.y1) * t);
        await sleep(dur / steps);
        control.write(touchPacket(ACTION_MOVE, x, y, screen));
      }
      await sleep(dur / steps);
      control.write(touchPacket(ACTION_UP, px(g.x2), py(g.y2), screen));
      return;
    }
    case "touch": {
      control.write(touchPacket(actionCode(g.action), px(g.x), py(g.y), screen, BigInt(g.pointerId ?? 0)));
      return;
    }
    case "key": {
      const metaState = g.metaState ?? 0;
      if (g.action === "down") {
        control.write(keyPacket(ACTION_DOWN, g.keycode, metaState));
      } else if (g.action === "up") {
        control.write(keyPacket(ACTION_UP, g.keycode, metaState));
      } else {
        control.write(keyPacket(ACTION_DOWN, g.keycode, metaState));
        control.write(keyPacket(ACTION_UP, g.keycode, metaState));
      }
      return;
    }
    case "text":
      control.write(textPacket(g.text));
      return;
    case "back":
      control.write(backOrScreenOnPacket(ACTION_DOWN));
      control.write(backOrScreenOnPacket(ACTION_UP));
      return;
    case "home":
      control.write(keyPacket(ACTION_DOWN, KEY.home));
      control.write(keyPacket(ACTION_UP, KEY.home));
      return;
    case "recents":
      control.write(keyPacket(ACTION_DOWN, KEY.recents));
      control.write(keyPacket(ACTION_UP, KEY.recents));
      return;
    case "power":
      control.write(keyPacket(ACTION_DOWN, KEY.power));
      control.write(keyPacket(ACTION_UP, KEY.power));
      return;
  }
}
