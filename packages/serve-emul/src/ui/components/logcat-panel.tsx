import { useEffect, useRef, useState } from "react";
import { parseLogcatEventJson } from "../../shared/api-contracts";

type LogLine = {
  id: number;
  line: string;
  at: string;
};

const MAX_LINES = 500;

export function LogcatPanel() {
  const nextIdRef = useRef(1);
  const pausedRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [packageName, setPackageName] = useState("");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("Off");

  const disconnect = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setEnabled(false);
    setStatus("Off");
  };

  const connect = () => {
    eventSourceRef.current?.close();
    const params = new URLSearchParams();
    if (packageName.trim()) params.set("package", packageName.trim());
    if (search.trim()) params.set("search", search.trim());
    const source = new EventSource(`/api/logcat?${params}`);
    eventSourceRef.current = source;
    setEnabled(true);
    setStatus("Connecting");
    source.addEventListener("ready", (event) => {
      try {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          throw new TypeError("invalid logcat ready event");
        }
        parseLogcatEventJson("ready", event.data);
        setStatus("Streaming");
      } catch {
        setStatus("Invalid stream event");
      }
    });
    source.addEventListener("log", (event) => {
      if (pausedRef.current) return;
      try {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          throw new TypeError("invalid logcat event");
        }
        const data = parseLogcatEventJson("log", event.data);
        setLines((current) =>
          [...current, { id: nextIdRef.current++, line: data.line, at: data.at }].slice(-MAX_LINES),
        );
      } catch {}
    });
    source.addEventListener("error", (event) => {
      if (event instanceof MessageEvent && typeof event.data === "string") {
        try {
          const data = parseLogcatEventJson("error", event.data);
          setStatus(data.line || "Error");
          return;
        } catch {}
      }
      setStatus("Error");
    });
    source.addEventListener("close", (event) => {
      try {
        if (event instanceof MessageEvent && typeof event.data === "string") {
          parseLogcatEventJson("close", event.data);
        }
      } finally {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
        setEnabled(false);
        setStatus("Closed");
      }
    });
  };

  useEffect(() => {
    return disconnect;
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const copyLogs = async () => {
    await navigator.clipboard.writeText(lines.map((line) => line.line).join("\n"));
    setStatus("Copied");
  };

  return (
    <section className="tool-panel logcat-panel">
      <div className="panel-heading">
        <h2>Logcat</h2>
        <div className="location-status">{status} • {lines.length}</div>
      </div>
      <div className="coordinate-grid">
        <label>
          Package
          <input
            onChange={(e) => setPackageName(e.currentTarget.value)}
            placeholder="com.example.app"
            value={packageName}
          />
        </label>
        <label>
          Search
          <input
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="error"
            value={search}
          />
        </label>
      </div>
      <div className="panel-actions">
        <button onClick={connect}>{enabled ? "Apply" : "Start"}</button>
        <button onClick={disconnect} disabled={!enabled}>Stop</button>
        <button onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</button>
        <button onClick={() => setLines([])}>Clear</button>
        <button onClick={() => void copyLogs()}>Copy</button>
      </div>
      <pre className="logcat-output">
        {lines.length ? lines.map((entry) => entry.line).join("\n") : enabled ? "Waiting for logcat..." : "Logcat is off."}
      </pre>
    </section>
  );
}
