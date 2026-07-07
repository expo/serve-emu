import type nodeDataChannel from "node-datachannel";
import type {
  DataChannel,
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

const PAYLOAD_TYPE_H264 = 96;
const RTP_CLOCK_RATE = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 3_000;
const MAX_TRACK_BUFFERED_BYTES = 4 * 1024 * 1024;

let loggerInitialized = false;

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

export async function createWebRtcPublisher(options: WebRtcPublisherOptions): Promise<WebRtcPublisher> {
  const imported = await import("node-datachannel");
  const ndc = imported.default;
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
    try {
      const answer = await peer.answer(offer);
      this.peers.add(peer);
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
  readonly track: Track;
  readonly pc: PeerConnection;
  readonly rtpConfig: RtpPacketizationConfig;
  closed = false;
  private dataChannel: DataChannel | null = null;
  private trackOpen = false;
  private awaitingKeyFrame = true;
  private sentFrames = 0;
  private droppedFrames = 0;
  private backpressureEvents = 0;
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
    this.pc = new params.ndc.PeerConnection(`serve-emu-${params.id}`, {
      iceServers: iceUrlsForNodeDataChannel(params.settings.iceServers),
      iceTransportPolicy: params.settings.iceTransportPolicy,
      forceMediaTransport: true,
    });

    const video = new params.ndc.Video("video", "SendOnly");
    video.addH264Codec(PAYLOAD_TYPE_H264);
    video.setBitrate(Math.max(100, Math.round(params.bitRate / 1000)));

    this.rtpConfig = new params.ndc.RtpPacketizationConfig(
      randomSsrc(),
      "serve-emu",
      PAYLOAD_TYPE_H264,
      RTP_CLOCK_RATE,
    );
    const packetizer = new params.ndc.H264RtpPacketizer("StartSequence", this.rtpConfig);
    this.track = this.pc.addTrack(video);
    this.track.setMediaHandler(packetizer);

    this.track.onOpen(() => {
      this.trackOpen = true;
      this.awaitingKeyFrame = true;
      this.params.onKeyframeRequest("WebRTC track opened");
    });
    this.track.onClosed(() => this.close());
    this.track.onError((err) => {
      this.lastError = err;
      this.close();
    });

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
    this.pc.setRemoteDescription(offer.sdp, "offer");
    const localDescription = await this.createLocalAnswer();
    await this.waitForIceGathering();
    const finalDescription = this.pc.localDescription() ?? localDescription;
    if (!finalDescription?.sdp) throw new Error("WebRTC answer was not created");
    return { type: finalDescription.type, sdp: finalDescription.sdp };
  }

  sendFrame(payload: Buffer, isKeyFrame: boolean): void {
    if (this.closed || !this.trackOpen || !this.track.isOpen()) return;
    if (this.awaitingKeyFrame) {
      if (!isKeyFrame) {
        this.droppedFrames++;
        return;
      }
      this.awaitingKeyFrame = false;
    }

    const buffered = this.track.bufferedAmount();
    if (buffered > MAX_TRACK_BUFFERED_BYTES) {
      this.backpressureEvents++;
      this.droppedFrames++;
      this.awaitingKeyFrame = true;
      this.params.onKeyframeRequest("WebRTC track backpressure");
      return;
    }

    const elapsedMs = Date.now() - this.createdMs;
    this.lastRtpTimestamp = Math.max(this.lastRtpTimestamp + 1, Math.round(elapsedMs * 90));
    this.rtpConfig.timestamp = this.lastRtpTimestamp;

    try {
      if (this.track.sendMessageBinary(payload)) {
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
      this.track.close();
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
      backpressureEvents: this.backpressureEvents,
      inputMessages: this.inputMessages,
      bufferedBytes: this.closed ? 0 : this.track.bufferedAmount(),
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
