import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { buildCodecString, scanAU } from "./h264";
import { MsePlayer } from "./mse-player";
import { withDevice } from "./device";
import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from "./webrtc-negotiation";

export type DeviceSize = { width: number; height: number };

export type StreamState = {
  status: string;
  fps: number;
  deviceSize: DeviceSize | null;
};

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;

export type StreamTransport = "websocket" | "webrtc";

export type WebRtcIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type StreamSettings =
  | { transport: "websocket" }
  | {
      transport: "webrtc";
      codec: "h264";
      iceServers: WebRtcIceServer[];
      iceTransportPolicy: RTCIceTransportPolicy;
    };

type ApiInfo = {
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
  lastFrameAt?: string | null;
  lastError?: string | null;
  stream?: StreamSettings;
};

const SOFT_DECODE_QUEUE_SIZE = 4;
const DECODER_RECOVERY_COOLDOWN_MS = 1500;
const KEYFRAME_REQUEST_COOLDOWN_MS = 1500;
const FRAME_QUEUE_SIZE = 2;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;
const DEFAULT_WEBRTC_ICE_SERVERS: WebRtcIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];
const WEBRTC_ICE_GATHERING_TIMEOUT_MS = 3_000;
const WEBRTC_SIGNALING_REQUEST_TIMEOUT_MS = 20_000;
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 4_000;
const WEBRTC_BUSY_RETRY_INTERVAL_MS = 500;
const WEBRTC_BUSY_RETRY_COUNT = 30;
const WEBRTC_TRANSPORT_RETRY_BASE_MS = 500;
const WEBRTC_TRANSPORT_RETRY_MAX_MS = 5_000;

type FramePacket = {
  data: Uint8Array;
  isKey: boolean | null;
  timestamp: number | null;
};

type BrowserRtpCodecCapability = {
  mimeType: string;
  sdpFmtpLine?: string;
};

function parseFramePacket(raw: ArrayBuffer | Uint8Array): FramePacket {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > FRAME_META_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_META_HEADER_BYTES);
    if (view.getUint32(0, false) === FRAME_META_MAGIC && view.getUint8(4) === FRAME_META_VERSION) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(FRAME_META_HEADER_BYTES),
        isKey: (view.getUint8(5) & FRAME_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

function createWebRtcSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function streamSettingsKey(settings: StreamSettings | null): string | null {
  return settings ? JSON.stringify(settings) : null;
}

function iceServersForBrowser(settings: StreamSettings): WebRtcIceServer[] {
  if (settings.transport !== "webrtc") return DEFAULT_WEBRTC_ICE_SERVERS;
  return settings.iceServers.length ? settings.iceServers : DEFAULT_WEBRTC_ICE_SERVERS;
}

function preferH264(transceiver: RTCRtpTransceiver): void {
  if (!("setCodecPreferences" in transceiver) || typeof RTCRtpReceiver === "undefined") return;
  const capabilities = RTCRtpReceiver.getCapabilities("video");
  const codecs = (capabilities?.codecs ?? []) as BrowserRtpCodecCapability[];
  if (codecs.length === 0) return;
  const isH264 = (codec: BrowserRtpCodecCapability) =>
    codec.mimeType.toLowerCase() === "video/h264";
  const hasMode1 = (codec: BrowserRtpCodecCapability) =>
    /(?:^|;)\s*packetization-mode=1(?:\s*;|$)/i.test(codec.sdpFmtpLine ?? "");
  const h264Mode1 = codecs.filter((codec) => isH264(codec) && hasMode1(codec));
  const h264Other = codecs.filter((codec) => isH264(codec) && !hasMode1(codec));
  transceiver.setCodecPreferences([
    ...h264Mode1,
    ...h264Other,
    ...codecs.filter((codec) => !isH264(codec)),
  ] as Parameters<RTCRtpTransceiver["setCodecPreferences"]>[0]);
}

async function waitForWebRtcIce(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let timeout: number | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      connection.removeEventListener("icegatheringstatechange", onState);
      if (timeout !== undefined) window.clearTimeout(timeout);
      resolve();
    };
    const onState = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    connection.addEventListener("icegatheringstatechange", onState);
    timeout = window.setTimeout(finish, WEBRTC_ICE_GATHERING_TIMEOUT_MS);
  });
}

export function useStream(
  canvasRef: RefObject<HTMLCanvasElement>,
  videoRef: RefObject<HTMLVideoElement>,
  serial: string | null,
) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    fps: 0,
    deviceSize: null,
  });
  const [streamSettings, setStreamSettings] = useState<StreamSettings | null>(null);
  const [webRtcRetryGeneration, setWebRtcRetryGeneration] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const webRtcTransportRetryAttemptRef = useRef(0);
  const transport = streamSettings?.transport ?? null;
  const currentStreamSettingsKey = streamSettingsKey(streamSettings);

  const send = useCallback<Sender>((msg, ack = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(ack ? msg : { ...msg, ack: false }));
  }, []);

  useEffect(() => {
    if (!serial) {
      setStreamSettings(null);
      setState((s) => ({ ...s, status: "waiting for device", fps: 0, deviceSize: null }));
      return;
    }

    let cancelled = false;
    let metadataTimer: ReturnType<typeof setInterval> | null = null;
    const apiUrl = withDevice("/api", serial);

    const applyServerStatus = (d: ApiInfo) => {
      const lastFrameAgeMs = d.lastFrameAt ? Date.now() - Date.parse(d.lastFrameAt) : 0;
      if (d.stream) {
        setStreamSettings((current) =>
          streamSettingsKey(current) === streamSettingsKey(d.stream ?? null) ? current : d.stream!,
        );
      } else {
        setStreamSettings((current) => current ?? { transport: "websocket" });
      }
      setState((s) => ({
        ...s,
        deviceSize: d.size,
        status:
          d.status && d.status !== "streaming"
            ? d.lastError || d.status
            : d.lastFrameAt && lastFrameAgeMs > 3000
              ? "stream stalled"
              : s.status,
      }));
    };

    const refresh = () => {
      fetch(apiUrl, { cache: "no-store" })
        .then((r) => r.json() as Promise<ApiInfo>)
        .then((d) => {
          if (!cancelled) applyServerStatus(d);
        })
        .catch(() => {
          if (!cancelled) {
            setStreamSettings(null);
            setState((s) => ({ ...s, status: "metadata unavailable" }));
          }
        });
    };

    refresh();
    metadataTimer = setInterval(refresh, 1500);

    return () => {
      cancelled = true;
      if (metadataTimer) clearInterval(metadataTimer);
    };
  }, [serial]);

  useEffect(() => {
    if (transport !== "websocket") return;
    // WebCodecs (`VideoDecoder`) is a secure-context-only API, so it's absent
    // over a plain-HTTP LAN origin. Fall back to Media Source Extensions — not
    // secure-context gated — which decodes the same H.264 via a <video> element
    // blitted onto the canvas (see MsePlayer).
    const canWebCodecs = "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;
    const useMse = !canWebCodecs;
    if (useMse && !MsePlayer.isSupported()) {
      setState((s) => ({ ...s, status: "WebCodecs unsupported" }));
      return;
    }

    if (!serial) {
      setState((s) => ({ ...s, status: "waiting for device", deviceSize: null }));
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;
    let msePlayer: MsePlayer | null = null;
    let sawKeyframe = false;
    let frameIdx = 0;
    let fpsCount = 0;
    let fpsTimer = performance.now();
    let frameQueue: (VideoFrame | null)[] = new Array(FRAME_QUEUE_SIZE).fill(null);
    let frameQueueHead = 0;
    let frameQueueCount = 0;
    let renderRaf = 0;
    let lastDecoderRecoveryAt = 0;
    let lastKeyframeRequestAt = 0;
    let droppingUntilKeyframe = false;

    const setStatus = (s: string) =>
      setState((prev) => (prev.status === s ? prev : { ...prev, status: s }));

    const clearFrameQueue = () => {
      if (renderRaf) {
        cancelAnimationFrame(renderRaf);
        renderRaf = 0;
      }
      for (let i = 0; i < FRAME_QUEUE_SIZE; i++) {
        frameQueue[i]?.close();
        frameQueue[i] = null;
      }
      frameQueueHead = 0;
      frameQueueCount = 0;
    };

    const closeDecoder = () => {
      if (!decoder) return;
      try {
        if (decoder.state !== "closed") decoder.close();
      } catch {}
      decoder = null;
    };

    const beginDecoderRecovery = () => {
      const now = performance.now();
      if (now - lastDecoderRecoveryAt < DECODER_RECOVERY_COOLDOWN_MS && droppingUntilKeyframe) return;
      lastDecoderRecoveryAt = now;
      closeDecoder();
      clearFrameQueue();
      sawKeyframe = false;
      frameIdx = 0;
      droppingUntilKeyframe = true;
      requestKeyframe();
      setStatus("recovering video");
    };

    const requestKeyframe = () => {
      const ws = wsRef.current;
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
      lastKeyframeRequestAt = now;
      ws.send(JSON.stringify({ type: "reset-video", ack: false }));
    };

    const renderFromQueue = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      renderRaf = 0;
      if (frameQueueCount === 0) return;

      const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
      const frame = frameQueue[tail]!;
      frameQueue[tail] = null;
      frameQueueCount--;

      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();

      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1000) {
        const fps = Math.round((fpsCount * 1000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setState((s) => (s.fps === fps ? s : { ...s, fps }));
      }

      if (frameQueueCount > 0) {
        renderRaf = requestAnimationFrame(() => renderFromQueue(canvas, ctx));
      }
    };

    const ensureDecoder = (spsBytes: Uint8Array): boolean => {
      if (decoder?.state === "configured") return true;
      closeDecoder();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
      if (!canvas || !ctx) return false;
      const codec = buildCodecString(spsBytes);
      let dec: VideoDecoder;
      dec = new VideoDecoder({
        output: (frame) => {
          if (decoder !== dec) {
            frame.close();
            return;
          }
          if (frameQueueCount >= FRAME_QUEUE_SIZE) {
            const tail = (frameQueueHead - frameQueueCount + FRAME_QUEUE_SIZE) % FRAME_QUEUE_SIZE;
            frameQueue[tail]?.close();
            frameQueue[tail] = null;
            frameQueueCount--;
          }
          frameQueue[frameQueueHead] = frame;
          frameQueueHead = (frameQueueHead + 1) % FRAME_QUEUE_SIZE;
          frameQueueCount++;
          if (!renderRaf) {
            renderRaf = requestAnimationFrame(() => renderFromQueue(canvas, ctx));
          }
        },
        error: (e) => {
          console.error("VideoDecoder error", e);
          setStatus("decoder error");
          if (decoder === dec) beginDecoderRecovery();
        },
      });
      try {
        dec.configure({ codec, optimizeForLatency: true });
        decoder = dec;
        console.log("VideoDecoder configured:", codec);
        return true;
      } catch (e) {
        console.error("VideoDecoder configure failed", e);
        try {
          dec.close();
        } catch {}
        setStatus("decoder config failed");
        requestKeyframe();
        return false;
      }
    };

    const feedFrame = (raw: ArrayBuffer | Uint8Array) => {
      const packet = parseFramePacket(raw);

      if (useMse) {
        const isKey = packet.isKey ?? scanAU(packet.data).isKey;
        if (!msePlayer) {
          const canvas = canvasRef.current;
          if (!canvas) {
            requestKeyframe();
            return;
          }
          msePlayer = new MsePlayer(canvas, {
            onFirstFrame: () => setStatus("streaming"),
            onResize: (width, height) =>
              setState((s) => ({ ...s, deviceSize: { width, height } })),
            onFps: (fps) => setState((s) => (s.fps === fps ? s : { ...s, fps })),
            onError: (message) => setStatus(message),
            requestKeyframe,
          });
        }
        msePlayer.feed(packet.data, isKey, packet.timestamp);
        return;
      }

      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!decoder || decoder.state !== "configured" || droppingUntilKeyframe));
      const scanned = needsScan ? scanAU(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      const spsBytes = scanned?.spsBytes ?? null;
      if (spsBytes && !ensureDecoder(spsBytes)) return;

      if (droppingUntilKeyframe) {
        if (!isKey) return;
        if (!decoder || decoder.state !== "configured") {
          requestKeyframe();
          return;
        }
        droppingUntilKeyframe = false;
      }

      if (!decoder || decoder.state !== "configured") {
        if (!isKey) requestKeyframe();
        return;
      }

      if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE_SIZE) {
        beginDecoderRecovery();
        return;
      }

      if (!sawKeyframe) {
        if (!isKey) {
          requestKeyframe();
          return;
        }
        sawKeyframe = true;
        setStatus("streaming");
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? "key" : "delta",
            timestamp: packet.timestamp ?? Math.round((frameIdx * 1_000_000) / 60),
            data: packet.data,
          }),
        );
        frameIdx++;
      } catch (e) {
        console.error("decode failed", e);
        beginDecoderRecovery();
      }
    };

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${withDevice("/ws?frame-meta=1", serial)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        setStatus("streaming");
        // MSE playback must begin on a keyframe; nudge the server to emit one now.
        if (useMse) requestKeyframe();
      };
      ws.onerror = () => setStatus("connection error");
      ws.onclose = () => {
        if (cancelled) return;
        const retryIn = reconnectDelay;
        setStatus(`disconnected — retrying in ${Math.round(retryIn / 1000)}s`);
        try {
          decoder?.close();
        } catch {}
        decoder = null;
        msePlayer?.destroy();
        msePlayer = null;
        frameIdx = 0;
        sawKeyframe = false;
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
        retryTimer = setTimeout(connect, retryIn);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          // The server announces an encoder restart with a new size (device
          // rotation) as a "video-session" message; resync onto the new stream.
          try {
            const msg = JSON.parse(e.data) as { type?: string; size?: DeviceSize };
            if (
              msg.type === "video-session" &&
              msg.size &&
              Number.isFinite(msg.size.width) &&
              Number.isFinite(msg.size.height)
            ) {
              closeDecoder();
              clearFrameQueue();
              msePlayer?.destroy();
              msePlayer = null;
              frameIdx = 0;
              sawKeyframe = false;
              droppingUntilKeyframe = true;
              setState((s) => ({ ...s, deviceSize: msg.size! }));
              requestKeyframe();
            }
          } catch {}
          return;
        }
        feedFrame(e.data);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        if (wsRef.current) wsRef.current.close();
      } catch {}
      clearFrameQueue();
      closeDecoder();
      msePlayer?.destroy();
      msePlayer = null;
      wsRef.current = null;
    };
  }, [canvasRef, serial, transport]);

  useEffect(() => {
    webRtcTransportRetryAttemptRef.current = 0;
  }, [serial, currentStreamSettingsKey]);

  useEffect(() => {
    if (transport !== "webrtc") return;
    if (!serial) {
      setState((s) => ({ ...s, status: "waiting for device", deviceSize: null }));
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const setStatus = (s: string) =>
      setState((prev) => (prev.status === s ? prev : { ...prev, status: s }));

    const connect = () => {
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${withDevice("/ws?video=0", serial)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        ws.send(JSON.stringify({ type: "reset-video", ack: false }));
      };
      ws.onerror = () => setStatus("input connection error");
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { ok?: boolean; error?: string };
          if (message.ok === false && message.error) setStatus(message.error);
        } catch {}
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (cancelled) return;
        const retryIn = reconnectDelay;
        setStatus(`input disconnected — retrying in ${Math.round(retryIn / 1000)}s`);
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
        retryTimer = setTimeout(connect, retryIn);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [serial, transport]);

  useEffect(() => {
    if (transport !== "webrtc" || !streamSettings || streamSettings.transport !== "webrtc") return;
    if (!serial) {
      setState((s) => ({ ...s, status: "waiting for device", deviceSize: null }));
      return;
    }
    const video = videoRef.current;
    if (!video) {
      setState((s) => ({ ...s, status: "video element unavailable" }));
      return;
    }
    if (typeof RTCPeerConnection === "undefined" || typeof RTCRtpReceiver === "undefined") {
      setState((s) => ({ ...s, status: "WebRTC unsupported" }));
      return;
    }

    let stopped = false;
    let failing = false;
    let pc: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let firstFrameTimeout: number | undefined;
    let videoFrameCallback: number | undefined;
    let framePollTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let firstFrameDecoded = false;
    let fpsCount = 0;
    let fpsTimer = performance.now();
    let lastVideoTime = -1;
    const lifecycleController = new AbortController();
    const sessionId = createWebRtcSessionId();
    const offerUrl = withDevice("/webrtc/offer", serial);
    const closeUrl = withDevice("/webrtc/close", serial);
    const iceServers = iceServersForBrowser(streamSettings);

    setState((s) => ({ ...s, status: "connecting WebRTC", fps: 0 }));

    const setStatus = (s: string) =>
      setState((prev) => (prev.status === s ? prev : { ...prev, status: s }));

    const requestKeyframe = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "reset-video", ack: false }));
    };

    const closeRemoteSession = (keepalive = false): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = closeWebRtcSession({ url: closeUrl, sessionId, keepalive });
      return closePromise;
    };

    const stopFrameObserver = () => {
      if (videoFrameCallback !== undefined && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrameCallback);
        videoFrameCallback = undefined;
      }
      if (framePollTimer !== undefined) {
        window.clearInterval(framePollTimer);
        framePollTimer = undefined;
      }
    };

    const markFrameDecoded = () => {
      firstFrameDecoded = true;
      webRtcTransportRetryAttemptRef.current = 0;
      if (firstFrameTimeout !== undefined) {
        window.clearTimeout(firstFrameTimeout);
        firstFrameTimeout = undefined;
      }
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setState((s) => ({
          ...s,
          status: "streaming",
          deviceSize: { width: video.videoWidth, height: video.videoHeight },
        }));
      } else {
        setStatus("streaming");
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1000) {
        const fps = Math.round((fpsCount * 1000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setState((s) => (s.fps === fps ? s : { ...s, fps }));
      }
    };

    const startFrameObserver = () => {
      stopFrameObserver();
      if (typeof video.requestVideoFrameCallback === "function") {
        const observe = () => {
          if (stopped) return;
          markFrameDecoded();
          videoFrameCallback = video.requestVideoFrameCallback(observe);
        };
        videoFrameCallback = video.requestVideoFrameCallback(observe);
        return;
      }
      framePollTimer = window.setInterval(() => {
        if (stopped || video.readyState < 2 || video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;
        markFrameDecoded();
      }, 250);
    };

    const closePeer = () => {
      stopFrameObserver();
      video.srcObject = null;
      pc?.close();
    };

    const failPermanently = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setStatus(message);
      closePeer();
      void closeRemoteSession();
    };

    const retryTransport = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      const attempt = webRtcTransportRetryAttemptRef.current++;
      const delay = Math.min(
        WEBRTC_TRANSPORT_RETRY_BASE_MS * 2 ** Math.min(attempt, 4),
        WEBRTC_TRANSPORT_RETRY_MAX_MS,
      );
      requestKeyframe();
      setStatus(`${message} Retrying...`);
      closePeer();
      void closeRemoteSession().finally(() => {
        if (stopped) return;
        retryTimer = window.setTimeout(() => {
          if (!stopped) setWebRtcRetryGeneration((generation) => generation + 1);
        }, delay);
      });
    };

    const releaseOnPageHide = () => void closeRemoteSession(true);
    window.addEventListener("pagehide", releaseOnPageHide);
    window.addEventListener("beforeunload", releaseOnPageHide);

    void (async () => {
      try {
        pc = new RTCPeerConnection({
          iceServers,
          iceTransportPolicy: streamSettings.iceTransportPolicy,
        });

        const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
        preferH264(transceiver);
        pc.ontrack = (event) => {
          if (stopped) return;
          firstFrameDecoded = false;
          event.track.onended = () => retryTransport("WebRTC video track ended.");
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
          if (firstFrameTimeout !== undefined) window.clearTimeout(firstFrameTimeout);
          firstFrameTimeout = window.setTimeout(() => {
            firstFrameTimeout = undefined;
            if (stopped || firstFrameDecoded) return;
            requestKeyframe();
            retryTransport("WebRTC did not establish a video path.");
          }, WEBRTC_FIRST_FRAME_TIMEOUT_MS);
          startFrameObserver();
        };
        pc.onconnectionstatechange = () => {
          if (stopped || !pc) return;
          if (pc.connectionState === "connected") setStatus("WebRTC connected");
          if (pc.connectionState === "failed") retryTransport("WebRTC connection failed.");
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForWebRtcIce(pc);
        const local = pc.localDescription;
        if (!local) throw new Error("WebRTC offer was not created");
        const response = await postWebRtcOffer({
          url: offerUrl,
          signal: lifecycleController.signal,
          requestTimeoutMs: WEBRTC_SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: WEBRTC_BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: WEBRTC_BUSY_RETRY_COUNT,
          body: JSON.stringify({
            type: local.type,
            sdp: local.sdp,
            sessionId,
            codec: streamSettings.codec,
            iceServers,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          failPermanently(`WebRTC offer failed: HTTP ${response.status}`);
          return;
        }
        const answer = (await response.json()) as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        if (
          typeof answer !== "object" ||
          answer === null ||
          typeof answer.type !== "string" ||
          typeof answer.sdp !== "string"
        ) {
          failPermanently("WebRTC returned an invalid session description.");
          return;
        }
        await pc.setRemoteDescription(answer);
      } catch (caught) {
        if (stopped || lifecycleController.signal.aborted) return;
        if (caught instanceof WebRtcSignalingBusyError) {
          failPermanently(caught.message);
          return;
        }
        const message = caught instanceof WebRtcSignalingTimeoutError
          ? "WebRTC signaling timed out."
          : "WebRTC signaling failed.";
        retryTransport(message);
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener("pagehide", releaseOnPageHide);
      window.removeEventListener("beforeunload", releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (firstFrameTimeout !== undefined) window.clearTimeout(firstFrameTimeout);
      void closeRemoteSession(true);
      closePeer();
    };
  }, [
    serial,
    videoRef,
    transport,
    currentStreamSettingsKey,
    webRtcRetryGeneration,
  ]);

  return { state, send, transport };
}
