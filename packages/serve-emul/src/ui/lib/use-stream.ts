import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { startPoller } from "./poller";
import {
  INITIAL_STREAM_STATE,
  applyStreamHealth,
  applyWorkerEvent,
  parseStreamHealth,
  parseStreamWorkerEvent,
} from "./stream-state";

export type {
  DeviceSize,
  StreamState,
  StreamStats,
} from "./stream-state";

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;

// A canvas can transfer control to an OffscreenCanvas only once, so the worker
// that received it must be reused if the effect re-runs for the same element.
const workerByCanvas = new WeakMap<HTMLCanvasElement, Worker>();

export function useStream(canvasRef: RefObject<HTMLCanvasElement>) {
  const [state, setState] = useState(INITIAL_STREAM_STATE);
  const workerRef = useRef<Worker | null>(null);

  const send = useCallback<Sender>((msg, ack = true) => {
    workerRef.current?.postMessage({
      type: "send",
      text: JSON.stringify(ack ? msg : { ...msg, ack: false }),
    });
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

    const setStatus = (status: string) =>
      setState((prev) => (prev.status === status ? prev : { ...prev, status }));

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?frame-meta=1`;

    let worker = workerByCanvas.get(canvas);
    if (!worker) {
      worker = new Worker(new URL("./stream-worker.ts", import.meta.url), { type: "module" });
      workerByCanvas.set(canvas, worker);
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: "init", canvas: offscreen, url }, [offscreen]);
    } else {
      worker.postMessage({ type: "connect" });
    }
    workerRef.current = worker;

    const onMessage = (e: MessageEvent) => {
      if (cancelled) return;
      const msg = parseStreamWorkerEvent(e.data);
      if (!msg) return;
      if (msg.type === "rendered") {
        hasRenderedFrame = true;
      } else if (msg.type === "stats") {
        if (msg.stats.rendered) hasRenderedFrame = true;
      }
      setState((current) => applyWorkerEvent(current, msg));
    };
    worker.addEventListener("message", onMessage);

    const stopHealthPoller = startPoller({
      intervalMs: 1_500,
      request: async (signal) => {
        const response = await fetch("/health", { signal });
        return parseStreamHealth(await response.json());
      },
      onValue: (health) => {
        setState((current) =>
          applyStreamHealth(current, health, {
            nowMs: Date.now(),
            hasRenderedFrame,
          })
        );
      },
      onError: () => setStatus("metadata unavailable"),
    });

    return () => {
      cancelled = true;
      stopHealthPoller();
      worker.removeEventListener("message", onMessage);
      worker.postMessage({ type: "stop" });
      workerRef.current = null;
    };
  }, [canvasRef]);

  return { state, send };
}
