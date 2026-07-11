import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../../shared/api-contracts";
import { apiRequest } from "../lib/api-client";

type SessionEvent = SessionSnapshot["events"][number];

function labelForEvent(event: SessionEvent): string {
  if (event.kind === "gesture") return `${event.gesture?.type ?? "gesture"} • ${event.source}`;
  const lat = event.location?.latitude.toFixed(5) ?? "?";
  const lng = event.location?.longitude.toFixed(5) ?? "?";
  return `location ${lat}, ${lng}`;
}

export function SessionPanel() {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [multiplier, setMultiplier] = useState("1");
  const [status, setStatus] = useState("Ready");

  const refresh = (signal?: AbortSignal) => {
    apiRequest("/api/session", { method: "GET", signal })
      .then(setSession)
      .catch(() => {
        if (!signal?.aborted) setStatus("Session unavailable");
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    const sync = () => refresh(controller.signal);
    sync();
    const timer = setInterval(sync, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const replay = async () => {
    const rate = Number(multiplier);
    if (!Number.isFinite(rate) || rate <= 0) {
      setStatus("Rate must be positive");
      return;
    }
    try {
      const data = await apiRequest("/api/session/replay", {
        method: "POST",
        body: { multiplier: rate },
      });
      setSession(data.session);
      setStatus("Replaying");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const stopReplay = async () => {
    try {
      const data = await apiRequest("/api/session/replay/stop", { method: "POST" });
      setSession(data.session);
      setStatus("Replay stopped");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const clear = async () => {
    try {
      const data = await apiRequest("/api/session", { method: "DELETE" });
      setSession(data.session);
      setStatus("Cleared");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(session?.events ?? [], null, 2));
    setStatus("Copied");
  };

  const recent = session?.events.slice(-6).reverse() ?? [];

  return (
    <section className="tool-panel session-panel">
      <div className="panel-heading">
        <h2>Session</h2>
        <div className="location-status">
          {session?.replaying ? "Replaying" : status} • {session?.events.length ?? 0}
        </div>
      </div>
      <div className="coordinate-grid">
        <label>
          Rate
          <input
            inputMode="decimal"
            onChange={(e) => setMultiplier(e.currentTarget.value)}
            value={multiplier}
          />
        </label>
        <label>
          Mode
          <input readOnly value={session?.recording ? "Recording" : "Paused"} />
        </label>
      </div>
      <div className="panel-actions">
        <button onClick={() => void replay()}>Replay</button>
        <button onClick={() => void stopReplay()}>Stop</button>
        <button onClick={() => void clear()}>Clear</button>
        <button onClick={() => void copy()}>Copy</button>
      </div>
      <div className="session-list">
        {recent.length
          ? recent.map((event) => (
              <div key={event.id}>
                <span>+{Math.round(event.delayMs)}ms</span>
                {labelForEvent(event)}
              </div>
            ))
          : <div>No recorded events</div>}
      </div>
      {session?.lastError && <div className="route-meta">{session.lastError}</div>}
    </section>
  );
}
