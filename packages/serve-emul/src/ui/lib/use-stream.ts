import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  parseHealthResponse,
  type DeviceSize,
  type HealthResponse,
} from "../../shared/api-contracts";
import type { WsClientMessage } from "../../shared/websocket-contracts";
import {
  parseWorkerEvent,
  type StreamStats,
  type WorkerCommand,
} from "../../shared/worker-contracts";

export type { DeviceSize, StreamStats };

export type StreamState = {
  status: string;
  fps: number;
  deviceSize: DeviceSize | null;
  stats: StreamStats | null;
};

export type Sender = (message: WsClientMessage) => void;

// A canvas can transfer control to an OffscreenCanvas only once, so the worker
// that received it must be reused if the effect re-runs for the same element.
const workerByCanvas = new WeakMap<HTMLCanvasElement, Worker>();

export function useStream(canvasRef: RefObject<HTMLCanvasElement>) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    fps: 0,
    deviceSize: null,
    stats: null,
  });
  const workerRef = useRef<Worker | null>(null);

  const send = useCallback<Sender>((message) => {
    const command: WorkerCommand = {
      type: "send",
      text: JSON.stringify(message),
    };
    workerRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof Worker !== "function" || typeof canvas.transferControlToOffscreen !== "function") {
      setState((s) => ({ ...s, status: "OffscreenCanvas unsupported" }));
      return;
    }

    let cancelled = false;
    let hasRenderedFrame = false;
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    const setStatus = (status: string) =>
      setState((prev) => (prev.status === status ? prev : { ...prev, status }));

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?frame-meta=1`;

    let worker = workerByCanvas.get(canvas);
    if (!worker) {
      worker = new Worker(new URL("./stream-worker.ts", import.meta.url), { type: "module" });
      workerByCanvas.set(canvas, worker);
      const offscreen = canvas.transferControlToOffscreen();
      const command: WorkerCommand<OffscreenCanvas> = {
        type: "init",
        canvas: offscreen,
        url,
      };
      worker.postMessage(command, [offscreen]);
    } else {
      worker.postMessage({ type: "connect" } satisfies WorkerCommand);
    }
    workerRef.current = worker;

    const onMessage = (e: MessageEvent) => {
      if (cancelled) return;
      try {
        const message = parseWorkerEvent(e.data);
        switch (message.type) {
          case "status":
            setStatus(message.status);
            break;
          case "session":
            setState((state) => ({ ...state, deviceSize: message.size }));
            break;
          case "rendered":
            hasRenderedFrame = true;
            break;
          case "stats":
            if (message.stats.rendered) hasRenderedFrame = true;
            setState((state) => ({
              ...state,
              fps: message.stats.fps,
              stats: message.stats,
            }));
            break;
        }
      } catch {
        setStatus("invalid worker message");
      }
    };
    worker.addEventListener("message", onMessage);

    const applyServerStatus = (d: HealthResponse) => {
      const lastFrameAgeMs = d.lastFrameAt ? Date.now() - Date.parse(d.lastFrameAt) : Infinity;
      setState((s) => ({
        ...s,
        deviceSize: d.size,
        status:
          d.status && d.status !== "streaming"
            ? d.lastError || d.status
            : !hasRenderedFrame && lastFrameAgeMs > 5000
              ? "waiting for video"
              : s.status === "stream stalled" ||
                  s.status === "metadata unavailable" ||
                  s.status === "waiting for video"
                ? "streaming"
              : s.status,
      }));
    };

    fetch("/health")
      .then((response) => response.json())
      .then(parseHealthResponse)
      .then((d) => {
        if (!cancelled) applyServerStatus(d);
      })
      .catch(() => {
        if (!cancelled) setStatus("metadata unavailable");
      });

    healthTimer = setInterval(() => {
      fetch("/health")
        .then((response) => response.json())
        .then(parseHealthResponse)
        .then((d) => {
          if (!cancelled) applyServerStatus(d);
        })
        .catch(() => {
          if (!cancelled) setStatus("metadata unavailable");
        });
    }, 1500);

    return () => {
      cancelled = true;
      if (healthTimer) clearInterval(healthTimer);
      worker.removeEventListener("message", onMessage);
      worker.postMessage({ type: "stop" } satisfies WorkerCommand);
      workerRef.current = null;
    };
  }, [canvasRef]);

  return { state, send };
}
