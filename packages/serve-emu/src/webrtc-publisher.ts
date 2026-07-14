import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type nodeDataChannel from "node-datachannel";
import type {
  DataChannel,
  H264RtpPacketizer,
  PeerConnection,
  RtpPacketizationConfig,
  Track,
} from "node-datachannel";
import type { VideoFrame } from "./scrcpy.ts";
import type { StreamSettings, WebRtcIceServer } from "./stream-settings.ts";

export type WebRtcOffer = {
  type: string;
  sdp: string;
  codec?: string;
};

export type WebRtcAnswer = {
  type: string;
  sdp: string;
};

export type WebRtcPublisherOptions = {
  settings: Extract<StreamSettings, { transport: "webrtc" }>;
  bitRate: number;
  onInput: (payload: unknown, peerId: number) => void;
  onKeyframeRequest: (reason: string) => void;
};

type NodeDataChannel = typeof nodeDataChannel;

const requireModule = createRequire(import.meta.url);
const RTP_CLOCK_RATE = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 3_000;

let loggerInitialized = false;
let nativeRepairAttempted = false;

function randomSsrc(): number {
  return Math.floor(1 + Math.random() * 0x7ffffffe);
}

function parseOffer(value: unknown): WebRtcOffer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("WebRTC offer must be an object");
  }
  const offer = value as Record<string, unknown>;
  if (offer.type !== "offer") throw new Error("WebRTC offer type must be offer");
  if (typeof offer.sdp !== "string" || offer.sdp.length === 0) {
    throw new Error("WebRTC offer sdp must be a string");
  }
  if (offer.codec !== undefined && offer.codec !== "h264") {
    throw new Error("serve-emu WebRTC currently supports only H.264");
  }
  return { type: "offer", sdp: offer.sdp, codec: "h264" };
}

// The browser (offerer) owns the payload-type numbering: RTP we send must use a
// payload type its offer maps to H264, or it will be decoded as another codec.
// Our packetizer fragments NALUs, so packetization-mode=1 entries are preferred.
export function selectH264Media(offerSdp: string): { payloadType: number; mid: string } {
  let inVideoSection = false;
  let mid: string | null = null;
  const h264PayloadTypes: number[] = [];
  const fmtpByPayloadType = new Map<number, string>();
  for (const line of offerSdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      inVideoSection = line.startsWith("m=video");
      continue;
    }
    if (!inVideoSection) continue;
    const midLine = /^a=mid:(\S+)/.exec(line);
    if (midLine && mid === null) mid = midLine[1]!;
    const rtpmap = /^a=rtpmap:(\d+) H264\/90000/i.exec(line);
    if (rtpmap) h264PayloadTypes.push(Number(rtpmap[1]));
    const fmtp = /^a=fmtp:(\d+) (.+)$/.exec(line);
    if (fmtp) fmtpByPayloadType.set(Number(fmtp[1]), fmtp[2]!.toLowerCase());
  }
  if (h264PayloadTypes.length === 0 || mid === null) {
    throw new Error("WebRTC offer does not include an H.264 video media section");
  }
  const score = (payloadType: number): number => {
    const fmtp = fmtpByPayloadType.get(payloadType) ?? "";
    let value = 0;
    if (fmtp.includes("packetization-mode=1")) value += 4;
    const profile = /profile-level-id=([0-9a-f]{6})/.exec(fmtp)?.[1];
    if (profile?.startsWith("42e0")) value += 2; // constrained baseline
    else if (profile?.startsWith("42")) value += 1; // baseline
    return value;
  };
  const payloadType = h264PayloadTypes.reduce((best, pt) => (score(pt) > score(best) ? pt : best));
  return { payloadType, mid };
}

export function injectVideoSsrc(sdp: string, mid: string, ssrc: number): string {
  const lines = sdp.split("\r\n");
  const midIndex = lines.indexOf(`a=mid:${mid}`);
  if (midIndex === -1 || lines.some((l) => l.startsWith("a=ssrc:"))) return sdp;
  lines.splice(midIndex + 1, 0, `a=ssrc:${ssrc} cname:serve-emu`);
  return lines.join("\r\n");
}

function stringFromMessage(message: string | Buffer | ArrayBuffer): string | null {
  if (typeof message === "string") return message;
  if (Buffer.isBuffer(message)) return message.toString("utf8");
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  return null;
}

function iceUrlsForNodeDataChannel(servers: WebRtcIceServer[]): string[] {
  const urls: string[] = [];
  for (const server of servers) {
    for (const url of server.urls) {
      if (/^turns?:/i.test(url) && server.username && server.credential && !url.includes("@")) {
        const schemeMatch = /^(turns?:)/i.exec(url);
        if (!schemeMatch) {
          urls.push(url);
          continue;
        }
        const scheme = schemeMatch[1]!;
        const rest = url.slice(scheme.length);
        urls.push(
          `${scheme}${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${rest}`,
        );
      } else {
        urls.push(url);
      }
    }
  }
  return urls;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingNativeBindingError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("node_datachannel.node") || message.includes("build/Release");
}

function nodeDataChannelPackageDir(): string {
  const entry = requireModule.resolve("node-datachannel");
  return join(dirname(entry), "..", "..", "..");
}

function requireNativeNodeDataChannel(): NodeDataChannel {
  return requireModule(
    join(nodeDataChannelPackageDir(), "build", "Release", "node_datachannel.node"),
  ) as NodeDataChannel;
}

function runPrebuildInstall(packageDir: string): Promise<void> {
  const packageRequire = createRequire(join(packageDir, "package.json"));
  const prebuildInstallBin = packageRequire.resolve("prebuild-install/bin.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prebuildInstallBin, "-r", "napi"], {
      cwd: packageDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `prebuild-install exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
        ),
      );
    });
  });
}

async function loadNodeDataChannel(): Promise<NodeDataChannel> {
  try {
    return requireNativeNodeDataChannel();
  } catch (err) {
    if (!isMissingNativeBindingError(err) || nativeRepairAttempted) throw err;
    nativeRepairAttempted = true;
    const packageDir = nodeDataChannelPackageDir();
    console.warn(
      "node-datachannel native binding is missing; attempting to download the prebuilt N-API binary...",
    );
    try {
      await runPrebuildInstall(packageDir);
      return requireNativeNodeDataChannel();
    } catch (repairErr) {
      throw new Error(
        `node-datachannel native binding is missing and automatic repair failed. ` +
          `Run "bun pm trust node-datachannel" and "bun install", then retry. ` +
          `Original error: ${errorMessage(err)}. Repair error: ${errorMessage(repairErr)}`,
      );
    }
  }
}

export async function createWebRtcPublisher(options: WebRtcPublisherOptions): Promise<WebRtcPublisher> {
  const ndc = await loadNodeDataChannel();
  if (!loggerInitialized) {
    loggerInitialized = true;
    ndc.initLogger("Warning");
  }
  return new WebRtcPublisher(ndc, options);
}

export class WebRtcPublisher {
  private nextPeerId = 1;
  private readonly peers = new Set<WebRtcPeer>();

  constructor(
    private readonly ndc: NodeDataChannel,
    private readonly options: WebRtcPublisherOptions,
  ) {}

  get activePeerCount(): number {
    let count = 0;
    for (const peer of this.peers) {
      if (!peer.closed) count++;
    }
    return count;
  }

  async handleOffer(payload: unknown): Promise<WebRtcAnswer> {
    const offer = parseOffer(payload);
    const peer = new WebRtcPeer({
      id: this.nextPeerId++,
      ndc: this.ndc,
      settings: this.options.settings,
      bitRate: this.options.bitRate,
      onInput: this.options.onInput,
      onKeyframeRequest: this.options.onKeyframeRequest,
      onClose: (closedPeer) => this.peers.delete(closedPeer),
    });
    this.peers.add(peer);
    try {
      const answer = await peer.answer(offer);
      if (peer.closed) throw new Error("WebRTC peer closed before answer was created");
      this.options.onKeyframeRequest("WebRTC peer opened");
      return answer;
    } catch (err) {
      peer.close();
      throw err;
    }
  }

  sendFrame(frame: VideoFrame, config: Buffer | null): void {
    if (this.peers.size === 0) return;
    const payload = frame.isKey && config ? Buffer.concat([config, frame.data]) : frame.data;
    for (const peer of this.peers) {
      peer.sendFrame(payload, frame.isKey);
    }
  }

  snapshot() {
    return {
      peers: this.peers.size,
      activePeers: this.activePeerCount,
      detail: Array.from(this.peers, (peer) => peer.snapshot()),
    };
  }

  close(): void {
    for (const peer of this.peers) peer.close();
    this.peers.clear();
  }
}

class WebRtcPeer {
  readonly id: number;
  readonly pc: PeerConnection;
  closed = false;
  private track: Track | null = null;
  private rtpConfig: RtpPacketizationConfig | null = null;
  private packetizer: H264RtpPacketizer | null = null;
  private dataChannel: DataChannel | null = null;
  private trackOpen = false;
  private awaitingKeyFrame = true;
  private sentFrames = 0;
  private droppedFrames = 0;
  private inputMessages = 0;
  private lastFrameAt: string | null = null;
  private lastState = "new";
  private lastIceState = "new";
  private lastError: string | null = null;
  private readonly createdMs = Date.now();
  private lastRtpTimestamp = 0;

  constructor(
    private readonly params: {
      id: number;
      ndc: NodeDataChannel;
      settings: Extract<StreamSettings, { transport: "webrtc" }>;
      bitRate: number;
      onInput: (payload: unknown, peerId: number) => void;
      onKeyframeRequest: (reason: string) => void;
      onClose: (peer: WebRtcPeer) => void;
    },
  ) {
    this.id = params.id;
    // Auto-negotiation must stay off: the browser is the offerer, and any local
    // mutation (addTrack, createDataChannel) would otherwise generate a local
    // offer and wedge the connection in have-local-offer before the remote
    // offer arrives.
    this.pc = new params.ndc.PeerConnection(`serve-emu-${params.id}`, {
      iceServers: iceUrlsForNodeDataChannel(params.settings.iceServers),
      iceTransportPolicy: params.settings.iceTransportPolicy,
      forceMediaTransport: true,
      disableAutoNegotiation: true,
    });

    // Fallback only — answer() adds the publishing track itself; attachTrack
    // ignores this callback once a track is attached.
    this.pc.onTrack((track) => this.attachTrack(track));
    this.pc.onDataChannel((channel) => this.attachDataChannel(channel));
    this.pc.onStateChange((state) => {
      this.lastState = state;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.close();
      }
    });
    this.pc.onIceStateChange((state) => {
      this.lastIceState = state;
    });
  }

  async answer(offer: WebRtcOffer): Promise<WebRtcAnswer> {
    const { payloadType, mid } = selectH264Media(offer.sdp);
    const ssrc = randomSsrc();
    this.rtpConfig = new this.params.ndc.RtpPacketizationConfig(
      ssrc,
      "serve-emu",
      payloadType,
      RTP_CLOCK_RATE,
    );
    this.packetizer = new this.params.ndc.H264RtpPacketizer("StartSequence", this.rtpConfig);
    // setRemoteDescription reciprocates the offer's recvonly video m-line and
    // emits the SendOnly track we publish on via onTrack (see attachTrack).
    // Adding our own track instead races the reciprocation and libdatachannel
    // can close it mid-negotiation, so we leave track creation to the library.
    this.pc.setRemoteDescription(offer.sdp, "offer");
    const localDescription = await this.createLocalAnswer();
    await this.waitForIceGathering();
    const finalDescription = this.pc.localDescription() ?? localDescription;
    if (!finalDescription?.sdp) throw new Error("WebRTC answer was not created");
    // libdatachannel does not declare an SSRC for reciprocated tracks, and
    // without an a=ssrc line the browser cannot route our RTP and silently
    // discards every packet — inject the SSRC the packetizer stamps.
    const sdp = injectVideoSsrc(finalDescription.sdp, mid, ssrc);
    return { type: finalDescription.type, sdp };
  }

  private attachTrack(track: Track): void {
    if (this.closed) {
      try {
        track.close();
      } catch {}
      return;
    }
    if (this.track) return;
    this.track = track;
    if (this.packetizer) track.setMediaHandler(this.packetizer);
    track.onOpen(() => {
      this.trackOpen = true;
      this.awaitingKeyFrame = true;
      this.params.onKeyframeRequest("WebRTC track opened");
    });
    track.onClosed(() => this.close());
    track.onError((err) => {
      this.lastError = err;
      this.close();
    });
  }

  sendFrame(payload: Buffer, isKeyFrame: boolean): void {
    const track = this.track;
    if (this.closed || !track || !this.rtpConfig || !this.trackOpen || !track.isOpen()) return;
    if (this.awaitingKeyFrame) {
      if (!isKeyFrame) {
        this.droppedFrames++;
        return;
      }
      this.awaitingKeyFrame = false;
    }

    const elapsedMs = Date.now() - this.createdMs;
    this.lastRtpTimestamp = Math.max(this.lastRtpTimestamp + 1, Math.round(elapsedMs * 90));
    this.rtpConfig.timestamp = this.lastRtpTimestamp;

    try {
      if (track.sendMessageBinary(payload)) {
        this.sentFrames++;
        this.lastFrameAt = new Date().toISOString();
      } else {
        this.droppedFrames++;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dataChannel?.close();
    } catch {}
    try {
      this.track?.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
    this.params.onClose(this);
  }

  snapshot() {
    return {
      id: this.id,
      state: this.lastState,
      iceState: this.lastIceState,
      trackOpen: this.trackOpen,
      dataChannelOpen: this.dataChannel?.isOpen() ?? false,
      sentFrames: this.sentFrames,
      droppedFrames: this.droppedFrames,
      inputMessages: this.inputMessages,
      awaitingKeyFrame: this.awaitingKeyFrame,
      lastFrameAt: this.lastFrameAt,
      lastError: this.lastError,
    };
  }

  private createLocalAnswer(): Promise<{ type: string; sdp: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out creating WebRTC answer"));
      }, ICE_GATHERING_TIMEOUT_MS);
      this.pc.onLocalDescription((sdp, type) => {
        clearTimeout(timeout);
        resolve({ type, sdp });
      });
      this.pc.setLocalDescription("answer");
    });
  }

  private waitForIceGathering(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.gatheringState() === "complete") {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timeout = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      this.pc.onGatheringStateChange((state) => {
        if (state !== "complete") return;
        clearTimeout(timeout);
        finish();
      });
    });
  }

  private attachDataChannel(channel: DataChannel): void {
    this.dataChannel = channel;
    channel.onMessage((message) => {
      const text = stringFromMessage(message);
      if (!text) return;
      this.inputMessages++;
      try {
        this.params.onInput(JSON.parse(text), this.id);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    });
    channel.onClosed(() => {
      if (this.dataChannel === channel) this.dataChannel = null;
    });
    channel.onError((err) => {
      this.lastError = err;
    });
  }
}
