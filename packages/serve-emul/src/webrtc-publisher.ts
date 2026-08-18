import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import type { WebRtcAnswer, WebRtcOffer } from "./webrtc-signaling.ts";

type NodeDataChannel = typeof nodeDataChannel;

export type WebRtcPublisherOptions = {
  settings: Extract<StreamSettings, { transport: "webrtc" }>;
  onInput?: (payload: unknown, peerId: number, sessionId: string) => void;
  onKeyframeRequest: (reason: string) => void;
};

type H264Media = { payloadType: number; mid: string };

const requireModule = createRequire(import.meta.url);
const RTP_CLOCK_RATE = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 3_000;

let loggerInitialized = false;
let nativeRepairAttempted = false;

function randomSsrc(): number {
  return Math.floor(1 + Math.random() * 0x7ffffffe);
}

function sdpEol(sdp: string): "\r\n" | "\n" {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

function hasPacketizationMode1(fmtp: string): boolean {
  return /(?:^|;)\s*packetization-mode=1(?:\s*;|$)/i.test(fmtp);
}

// The browser (offerer) owns payload-type numbering. RTP we send must use an
// H.264 payload type from the offer, and libdatachannel's packetizer emits
// FU-A fragments, so packetization-mode=1 is mandatory.
export function selectH264Media(offerSdp: string): H264Media {
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

  const compatiblePayloadTypes = h264PayloadTypes.filter((payloadType) =>
    hasPacketizationMode1(fmtpByPayloadType.get(payloadType) ?? "")
  );
  if (compatiblePayloadTypes.length === 0 || mid === null) {
    throw new Error("WebRTC offer does not include H.264 packetization-mode=1 video");
  }

  const score = (payloadType: number): number => {
    const fmtp = fmtpByPayloadType.get(payloadType) ?? "";
    const profile = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp)?.[1]?.toLowerCase();
    if (profile?.startsWith("42e0")) return 2;
    if (profile?.startsWith("42")) return 1;
    return 0;
  };
  const payloadType = compatiblePayloadTypes.reduce((best, pt) =>
    score(pt) > score(best) ? pt : best
  );
  return { payloadType, mid };
}

function sectionForMid(lines: string[], mid: string): { start: number; end: number; midIndex: number } | null {
  let sectionStart = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("m=")) sectionStart = index;
    if (line === `a=mid:${mid}` && sectionStart !== -1) {
      let sectionEnd = lines.length;
      for (let scan = index + 1; scan < lines.length; scan++) {
        if (lines[scan]!.startsWith("m=")) {
          sectionEnd = scan;
          break;
        }
      }
      return { start: sectionStart, end: sectionEnd, midIndex: index };
    }
  }
  return null;
}

export function injectVideoSsrc(sdp: string, mid: string, ssrc: number): string {
  const eol = sdpEol(sdp);
  const lines = sdp.split(/\r?\n/);
  const section = sectionForMid(lines, mid);
  if (!section) return sdp;
  const ssrcPrefix = `a=ssrc:${ssrc} `;
  if (lines.slice(section.start, section.end).some((line) => line.startsWith(ssrcPrefix))) return sdp;
  lines.splice(section.midIndex + 1, 0, `a=ssrc:${ssrc} cname:serve-emu`);
  return lines.join(eol);
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
  let dir = dirname(requireModule.resolve("node-datachannel"));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate node-datachannel package root");
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
  private readonly peers = new Map<string, WebRtcPeer>();
  private pendingSessionId: string | null = null;

  constructor(
    private readonly ndc: NodeDataChannel,
    private readonly options: WebRtcPublisherOptions,
  ) {}

  get activePeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (!peer.closed) count++;
    }
    return count;
  }

  async handleOffer(offer: WebRtcOffer): Promise<WebRtcAnswer> {
    if (this.pendingSessionId && this.pendingSessionId !== offer.sessionId) {
      throw new Error("WebRTC signaling already in progress");
    }

    const previous = this.peers.get(offer.sessionId);
    if (previous) previous.close();

    const peer = new WebRtcPeer({
      id: this.nextPeerId++,
      sessionId: offer.sessionId,
      ndc: this.ndc,
      settings: {
        ...this.options.settings,
        iceServers: offer.iceServers ?? this.options.settings.iceServers,
      },
      onInput: this.options.onInput,
      onKeyframeRequest: this.options.onKeyframeRequest,
      onClose: (closedPeer) => {
        if (this.peers.get(closedPeer.sessionId) === closedPeer) this.peers.delete(closedPeer.sessionId);
      },
    });
    this.peers.set(offer.sessionId, peer);
    this.pendingSessionId = offer.sessionId;
    try {
      const answer = await peer.answer(offer);
      if (peer.closed) throw new Error("WebRTC peer closed before answer was created");
      this.options.onKeyframeRequest("WebRTC peer opened");
      return answer;
    } catch (err) {
      peer.close();
      throw err;
    } finally {
      if (this.pendingSessionId === offer.sessionId) this.pendingSessionId = null;
    }
  }

  closeSession(sessionId: string): void {
    this.peers.get(sessionId)?.close();
  }

  sendFrame(frame: VideoFrame, config: Buffer | null): void {
    if (this.peers.size === 0) return;
    const payload = frame.isKey && config ? Buffer.concat([config, frame.data]) : frame.data;
    for (const peer of this.peers.values()) {
      peer.sendFrame(payload, frame.isKey);
    }
  }

  snapshot() {
    return {
      peers: this.peers.size,
      activePeers: this.activePeerCount,
      pendingSessionId: this.pendingSessionId,
      detail: Array.from(this.peers.values(), (peer) => peer.snapshot()),
    };
  }

  close(): void {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.pendingSessionId = null;
  }
}

class WebRtcPeer {
  readonly id: number;
  readonly sessionId: string;
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
      sessionId: string;
      ndc: NodeDataChannel;
      settings: Extract<StreamSettings, { transport: "webrtc" }>;
      onInput?: (payload: unknown, peerId: number, sessionId: string) => void;
      onKeyframeRequest: (reason: string) => void;
      onClose: (peer: WebRtcPeer) => void;
    },
  ) {
    this.id = params.id;
    this.sessionId = params.sessionId;
    // The browser is always the offerer. Local auto-negotiation can otherwise
    // wedge the peer in have-local-offer before the browser offer is applied.
    this.pc = new params.ndc.PeerConnection(`serve-emu-${params.id}`, {
      iceServers: iceUrlsForNodeDataChannel(params.settings.iceServers),
      iceTransportPolicy: params.settings.iceTransportPolicy,
      forceMediaTransport: true,
      disableAutoNegotiation: true,
    });

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
    // emits the SendOnly track we publish on via onTrack.
    this.pc.setRemoteDescription(offer.sdp, "offer");
    const localDescription = await this.createLocalAnswer();
    await this.waitForIceGathering();
    const finalDescription = this.pc.localDescription() ?? localDescription;
    if (!finalDescription?.sdp) throw new Error("WebRTC answer was not created");
    // libdatachannel omits a=ssrc for the reciprocated track; browsers then
    // silently discard RTP packets because they cannot route the SSRC.
    return {
      type: finalDescription.type,
      sdp: injectVideoSsrc(finalDescription.sdp, mid, ssrc),
    };
  }

  private attachTrack(track: Track): void {
    if (this.closed) {
      try {
        track.close();
      } catch {}
      return;
    }
    if (this.track) {
      try {
        track.close();
      } catch {}
      return;
    }
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
      this.lastError = errorMessage(err);
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
      sessionId: this.sessionId,
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
        this.params.onInput?.(JSON.parse(text), this.id, this.sessionId);
      } catch (err) {
        this.lastError = errorMessage(err);
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
