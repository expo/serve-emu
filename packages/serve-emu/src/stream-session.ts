import { ControlInputQueue } from "./control-input-queue.ts";
import { startGrpcSession } from "./grpc-session.ts";
import {
  startScrcpy,
  type ScrcpySession,
  type StartOpts,
  type VideoPacket,
} from "./scrcpy.ts";
import type { StreamMode } from "./shared/api-contracts.ts";
import { isAbnormalExit, procExitDetail } from "./session-status.ts";

export type StreamFailure = {
  message: string;
  code?: string;
  meta?: Record<string, string | number>;
};

export type StreamMeta = ScrcpySession["meta"];

export type RollingTimingSummary = {
  /** Number of samples retained in the rolling window. */
  windowSamples: number;
  latest: number;
  p50: number;
  p95: number;
  max: number;
};

/** Cumulative and rolling diagnostics for emulator gRPC screenshot capture. */
export type GrpcCaptureDiagnostics = {
  /** Raw framed protobuf messages parsed before the pacing/coalescing stage. */
  rawGrpcMessagesReceived: number;
  /** Raw messages released by the pacer for protobuf decoding. */
  rawGrpcMessagesEmitted: number;
  /** Pending raw messages replaced by a newer message in the same pacing window. */
  rawGrpcMessagesCoalesced: number;
  /** Decoded RGB images with complete, encoder-usable payloads. */
  usableImages: number;
  /** Missing emulator-produced sequence numbers observed between usable images. */
  sequenceGaps: number;
  /** Rolling intervals derived from the emulator's production timestamps. */
  sourceTimestampIntervalMs: RollingTimingSummary | null;
  /** Rolling emulator-production-to-host-receive latency. */
  productionToReceiveLatencyMs: RollingTimingSummary | null;
  freshEncoderWriteAttempts: number;
  repeatEncoderWriteAttempts: number;
  acceptedEncoderWrites: number;
  /** Encoder writes rejected while ffmpeg input was backpressured. */
  encoderBackpressureRejections: number;
};

export type EmuSessionDiagnostics = {
  /** Present only for the grpc-screenshot capture implementation. */
  grpcCapture?: GrpcCaptureDiagnostics;
};

/**
 * A stream source hides capture, encoding, input transport, keyframe recovery,
 * and cleanup behind one interface used by both the Bun server and middleware.
 */
export type EmuSession = {
  readonly mode: StreamMode;
  readonly serial: string;
  readonly meta: StreamMeta;
  readonly controls: ControlInputQueue;
  /** Optional source-specific live diagnostics, sampled without mutating capture. */
  readonly diagnostics?: () => EmuSessionDiagnostics;
  /** Present only on the scrcpy adapter during the server migration. */
  readonly rawScrcpy?: ScrcpySession;
  readFrame(): Promise<VideoPacket | null>;
  onFatal(listener: (failure: StreamFailure) => void): () => void;
  close(): Promise<void>;
};

export type StartEmuSessionOptions = StartOpts & {
  /** Exact source selection. This factory never silently falls back. */
  mode: StreamMode;
};

export async function startEmuSession(
  options: StartEmuSessionOptions,
): Promise<EmuSession> {
  if (options.mode === "grpc-screenshot") {
    if (!/^emulator-\d+$/.test(options.serial)) {
      throw new Error(
        `grpc-screenshot requires an Android Emulator serial; received ${options.serial}`,
      );
    }
    return startGrpcSession(options);
  }
  if (options.mode !== "scrcpy") {
    const exhaustive: never = options.mode;
    throw new Error(`unsupported stream mode ${String(exhaustive)}`);
  }
  return adaptScrcpySession(await startScrcpy(options));
}

export function adaptScrcpySession(
  raw: ScrcpySession,
  controls = new ControlInputQueue({ socket: raw.controlSocket }),
): EmuSession {
  const listeners = new Set<(failure: StreamFailure) => void>();
  let closed = false;
  let closeTask: Promise<void> | null = null;

  const emitFatal = (failure: StreamFailure) => {
    if (closed) return;
    for (const listener of listeners) listener(failure);
  };
  const onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (!isAbnormalExit(code, signal)) return;
    const { reason, ...detail } = procExitDetail(code, signal);
    emitFatal({ message: reason, ...detail });
  };
  const onControlError = (error: Error) => {
    emitFatal({
      message: `scrcpy control socket error: ${error.message}`,
      code: "control-socket-error",
    });
  };
  raw.proc.on("exit", onExit);
  raw.controlSocket.on("error", onControlError);

  return {
    mode: "scrcpy",
    serial: raw.serial,
    meta: raw.meta,
    controls,
    rawScrcpy: raw,
    readFrame: raw.readFrame,
    onFatal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closeTask) return closeTask;
      closed = true;
      raw.proc.off("exit", onExit);
      raw.controlSocket.off("error", onControlError);
      controls.close(new Error("stream session closed"));
      listeners.clear();
      closeTask = Promise.resolve(raw.close());
      return closeTask;
    },
  };
}
