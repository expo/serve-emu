#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { pickDevice } from "./adb.ts";
import { listAvds, listRunningAvds, startEmulator } from "./emulator.ts";
import { startServer } from "./server.ts";
import {
  DEFAULT_WEBRTC_ICE_SERVERS,
  type StreamSettings,
  type WebRtcIceServer,
  type WebRtcIceTransportPolicy,
} from "./stream-settings.ts";

const argv = Bun.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: "string", short: "p", default: "3300" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: "60" },
    "bit-rate": { type: "string", default: "8000000" },
    "max-size": { type: "string", default: "1920" },
    "key-frame-interval": { type: "string", default: "1" },
    transport: { type: "string", default: "websocket" },
    "stun-url": { type: "string" },
    "turn-url": { type: "string" },
    "turn-username": { type: "string" },
    "turn-credential": { type: "string" },
    "webrtc-ice-policy": { type: "string", default: "all" },
    avd: { type: "string" },
    "avd-list": { type: "boolean" },
    "running-avds": { type: "boolean" },
    "restart-avd": { type: "boolean" },
    emulator: { type: "string" },
    "emulator-port": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function numberOption(name: string, fallback: number): number {
  const value = values[name as keyof typeof values];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

function splitUrlList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function streamSettingsFromOptions(): StreamSettings {
  const transport = String(values.transport ?? "websocket").toLowerCase();
  if (transport !== "websocket" && transport !== "webrtc") {
    throw new Error("--transport must be one of: websocket, webrtc.");
  }

  if (transport === "websocket") return { transport: "websocket" };

  const icePolicy = String(values["webrtc-ice-policy"] ?? "all").toLowerCase();
  if (icePolicy !== "all" && icePolicy !== "relay") {
    throw new Error("--webrtc-ice-policy must be one of: all, relay.");
  }

  const iceServers: WebRtcIceServer[] = [];
  const stunUrls = splitUrlList(values["stun-url"]);
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  const turnUrls = splitUrlList(values["turn-url"]);
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      ...(values["turn-username"] ? { username: values["turn-username"] } : {}),
      ...(values["turn-credential"] ? { credential: values["turn-credential"] } : {}),
    });
  }

  return {
    transport: "webrtc",
    codec: "h264",
    iceServers: iceServers.length ? iceServers : DEFAULT_WEBRTC_ICE_SERVERS,
    iceTransportPolicy: icePolicy as WebRtcIceTransportPolicy,
  };
}

if (values.help) {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket/WebRTC

Usage:
  serve-emu [-p <port>] [-s <serial>] [--transport websocket|webrtc] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec]
  serve-emu --avd <name> [--restart-avd]
  serve-emu --avd-list
  serve-emu --running-avds

Options:
  -p, --port <port>      Port to listen on (default: 3300)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: 60)
      --bit-rate <bps>   H.264 bit rate (default: 8000000)
      --max-size <px>    Cap longest screen edge in pixels; 0 = native, but many
                         emulators reject native resolutions above ~2560 so this
                         defaults to 1920.
      --key-frame-interval <sec>
                         Ask the encoder for regular keyframes; 0 disables this
                         codec option (default: 1)
      --transport <mode>  Stream transport: websocket or webrtc (default: websocket)
      --stun-url <urls>   Comma-separated STUN URL(s) for WebRTC ICE
      --turn-url <urls>   Comma-separated TURN URL(s) for WebRTC ICE
      --turn-username <u> TURN username for --turn-url
      --turn-credential <c>
                         TURN credential for --turn-url
      --webrtc-ice-policy <all|relay>
                         ICE transport policy for WebRTC (default: all)
      --avd <name>       Launch this Android Virtual Device before streaming
      --restart-avd      Stop a running matching AVD before launching it
      --avd-list         Print available Android Virtual Device names
      --running-avds     Print currently running emulator AVDs
      --emulator <path>  Android Emulator binary (default: PATH or Android SDK)
      --emulator-port <n>
                         Emulator console port for --avd (even 5554-5682)
  -h, --help             Show this help
`);
  process.exit(0);
}

async function main() {
  if (values["avd-list"]) {
    console.log(listAvds(values.emulator).join("\n"));
    return;
  }

  if (values["running-avds"]) {
    const running = listRunningAvds();
    console.log(running.length ? running.map((avd) => `${avd.serial}\t${avd.avd}\t${avd.state}`).join("\n") : "");
    return;
  }

  if ((values["emulator-port"] || values["restart-avd"]) && !values.avd) {
    throw new Error("--emulator-port and --restart-avd require --avd.");
  }

  if (values.avd && values.serial) {
    throw new Error("Use either --avd to launch an emulator or --serial to attach to an existing device, not both.");
  }

  let emulatorLaunch: Awaited<ReturnType<typeof startEmulator>> | null = null;
  const serial = values.avd
    ? (emulatorLaunch = await startEmulator({
        avd: values.avd,
        emulatorPath: values.emulator,
        port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
        restartAvd: values["restart-avd"],
      })).serial
    : pickDevice(values.serial);
  const port = Number(values.port);
  const maxFps = numberOption("max-fps", 60);
  const bitRate = numberOption("bit-rate", 8_000_000);
  const maxSize = numberOption("max-size", 1920);
  const keyFrameInterval = numberOption("key-frame-interval", 1);
  const streamSettings = streamSettingsFromOptions();

  const { server, stop: stopServer } = await startServer({
    serial,
    port,
    maxFps,
    bitRate,
    maxSize,
    keyFrameInterval,
    streamSettings,
  }).catch((err) => {
    emulatorLaunch?.stop();
    throw err;
  });

  const stop = () => {
    stopServer();
    emulatorLaunch?.stop();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  console.log(`serve-emu → http://localhost:${server.port}  (device: ${serial})`);
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
