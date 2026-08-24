#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { listAvds, listRunningAvds, startEmulator } from "./emulator.ts";
import { parseAllowedOrigins } from "./origin-policy.ts";
import { startServer } from "./server.ts";
import {
  DEFAULT_WEBRTC_ICE_SERVERS,
  parseIceUrlList,
  type StreamSettings,
  type WebRtcIceServer,
  type WebRtcIceTransportPolicy,
} from "./stream-settings.ts";

const argv = Bun.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: "string", short: "p", default: "3300" },
    host: { type: "string", default: "127.0.0.1" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: "30" },
    "bit-rate": { type: "string", default: "8000000" },
    // 1280 caps the long edge while staying a clean multiple for common
    // 1080-wide devices (1080→576), so scrcpy doesn't pad the encode width and
    // bake in black letterbox columns the way 1024 (→460.8, rounded to 464) did.
    "max-size": { type: "string", default: "1280" },
    "key-frame-interval": { type: "string", default: "1" },
    transport: { type: "string", default: "websocket" },
    "stun-url": { type: "string" },
    "turn-url": { type: "string" },
    "turn-username": { type: "string" },
    "turn-credential": { type: "string" },
    "webrtc-ice-policy": { type: "string", default: "all" },
    "allow-origin": { type: "string" },
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

function stringOption(name: string): string | undefined {
  const value = values[name as keyof typeof values];
  return typeof value === "string" ? value : undefined;
}

function optionProvided(name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function streamSettingsFromOptions(): StreamSettings {
  const transport = stringOption("transport") ?? "websocket";
  if (transport !== "websocket" && transport !== "webrtc") {
    throw new Error("--transport must be one of: websocket, webrtc.");
  }

  const webRtcOptionNames = [
    "stun-url",
    "turn-url",
    "turn-username",
    "turn-credential",
    "webrtc-ice-policy",
  ];
  if (transport !== "webrtc" && webRtcOptionNames.some(optionProvided)) {
    throw new Error("WebRTC options require --transport webrtc.");
  }
  if (transport === "websocket") return { transport };

  const iceTransportPolicy = stringOption("webrtc-ice-policy") ?? "all";
  if (iceTransportPolicy !== "all" && iceTransportPolicy !== "relay") {
    throw new Error("--webrtc-ice-policy must be one of: all, relay.");
  }

  const stunUrl = stringOption("stun-url");
  const turnUrl = stringOption("turn-url");
  const turnUsername = stringOption("turn-username");
  const turnCredential = stringOption("turn-credential");
  if ((turnUsername !== undefined || turnCredential !== undefined) && turnUrl === undefined) {
    throw new Error("--turn-username and --turn-credential require --turn-url.");
  }
  if (turnUrl !== undefined && (!turnUsername || !turnCredential)) {
    throw new Error("--turn-url requires both --turn-username and --turn-credential.");
  }
  if (iceTransportPolicy === "relay" && turnUrl === undefined) {
    throw new Error("--webrtc-ice-policy relay requires --turn-url.");
  }

  const iceServers: WebRtcIceServer[] =
    stunUrl !== undefined
      ? [{ urls: parseIceUrlList(stunUrl, "stun") }]
      : DEFAULT_WEBRTC_ICE_SERVERS.map((server) => ({ ...server, urls: [...server.urls] }));
  if (turnUrl !== undefined) {
    iceServers.push({
      urls: parseIceUrlList(turnUrl, "turn"),
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return {
    transport,
    codec: "h264",
    iceServers,
    iceTransportPolicy: iceTransportPolicy as WebRtcIceTransportPolicy,
  };
}

if (values.help) {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket/WebRTC

Usage:
  serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec]
  serve-emu --transport webrtc [--stun-url url[,url...]] [--turn-url url[,url...] --turn-username user --turn-credential pass]
  serve-emu --avd <name> [--restart-avd]
  serve-emu --avd-list
  serve-emu --running-avds

Options:
  -p, --port <port>      Port to listen on (default: 3300)
      --host <host>      Host interface to bind (default: 127.0.0.1)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: 30)
      --bit-rate <bps>   H.264 bit rate (default: 8000000)
      --max-size <px>    Cap longest screen edge in pixels; 0 = native, but many
                         emulators reject native resolutions above ~2560 so this
                         defaults to 1280.
      --key-frame-interval <sec>
                         Ask the encoder for regular keyframes; 0 disables this
                         codec option (default: 1)
      --transport <websocket|webrtc>
                         Video transport for the browser UI (default: websocket)
      --stun-url <url[,url...]>
                         STUN URL(s) for WebRTC ICE; omitted = default public STUN
      --turn-url <url[,url...]>
                         TURN URL(s) for WebRTC ICE
      --turn-username <value>
                         TURN username for --turn-url
      --turn-credential <value>
                         TURN credential for --turn-url
      --webrtc-ice-policy <all|relay>
                         Browser/native ICE transport policy (default: all)
      --allow-origin <origin[,origin...]>
                         Extra browser origins allowed to signal/control; use *
                         only for trusted networks
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
  // Without --avd or -s, leave the serial undefined: the router picks the first
  // available device, so multiple booted devices no longer error.
  const serial = values.avd
    ? (emulatorLaunch = await startEmulator({
        avd: values.avd,
        emulatorPath: values.emulator,
        port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
        restartAvd: values["restart-avd"],
      })).serial
    : values.serial;
  const port = Number(values.port);
  const host = stringOption("host") ?? "127.0.0.1";
  const maxFps = numberOption("max-fps", 30);
  const bitRate = numberOption("bit-rate", 8_000_000);
  const maxSize = numberOption("max-size", 1280);
  const keyFrameInterval = numberOption("key-frame-interval", 1);
  const streamSettings = streamSettingsFromOptions();
  const allowOrigin = stringOption("allow-origin");
  const allowedOrigins = allowOrigin
    ? parseAllowedOrigins(allowOrigin)
    : [];

  const started = await startServer({
    serial,
    port,
    hostname: host,
    maxFps,
    bitRate,
    maxSize,
    keyFrameInterval,
    streamSettings,
    allowedOrigins,
  }).catch((err) => {
    emulatorLaunch?.stop();
    throw err;
  });
  const { server, stop: stopServer } = started;

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

  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  console.log(`serve-emu → http://${displayHost}:${server.port}  (device: ${started.serial})`);
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
