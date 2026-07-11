import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DeviceGridResponse,
  NightMode,
  NetworkResponse,
  OrientationMode,
} from "../../shared/api-contracts";
import { apiRequest } from "../lib/api-client";

type GridDevice = DeviceGridResponse["devices"][number];

type BusyAction = "select" | "start" | "stop";
const FONT_SCALE_PRESETS = [0.85, 1, 1.15, 1.3, 1.5] as const;

export function DevicePanel() {
  const [devices, setDevices] = useState<GridDevice[]>([]);
  const [status, setStatus] = useState("Loading...");
  const [sessionStatus, setSessionStatus] = useState<DeviceGridResponse["sessionStatus"]>("streaming");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, BusyAction | undefined>>({});

  const refresh = useCallback(async () => {
    try {
      const json = await apiRequest("/api/device-grid", { method: "GET", cache: "no-store" });
      setDevices(json.devices);
      setSessionStatus(json.sessionStatus);
      const running = json.devices.filter((device) => device.serial && device.state === "device").length;
      setStatus(`${running}/${json.devices.length} ready`);
    } catch (err) {
      setDevices([]);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const runDeviceAction = useCallback(
    async (device: GridDevice, action: BusyAction) => {
      setBusy((current) => ({ ...current, [device.id]: action }));
      setStatus(action === "select" ? "Switching..." : action === "start" ? "Starting..." : "Stopping...");
      try {
        if (action === "select") {
          if (!device.serial) throw new Error("Device serial is unavailable");
          await apiRequest("/api/devices/select", {
            method: "POST",
            body: { serial: device.serial },
          });
        } else if (action === "start") {
          await apiRequest("/api/avds/start", {
            method: "POST",
            body: { avd: device.avd ?? device.name },
          });
        } else {
          await apiRequest("/api/avds/stop", {
            method: "POST",
            body: { serial: device.serial ?? undefined, avd: device.avd ?? undefined },
          });
        }
        await refresh();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy((current) => {
          const next = { ...current };
          delete next[device.id];
          return next;
        });
      }
    },
    [refresh],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().replace(/^\/+/, "").toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) =>
      [device.name, device.serial ?? "", device.avd ?? "", device.kind, device.state]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [devices, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="device-panel">
      <div className="panel-heading">
        <h2>Devices</h2>
        <div className="location-status">{status}</div>
      </div>

      <div className="device-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search devices and AVDs"
        />
        {query ? <button onClick={() => setQuery("")}>Clear</button> : null}
      </div>

      <div className="device-list android-grid-list">
        {filtered.length === 0 ? (
          <div className="device-empty">{query ? "No matching Android targets." : "No Android targets found."}</div>
        ) : (
          filtered.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              sessionStatus={sessionStatus}
              busy={busy[device.id]}
              onSelect={() => void runDeviceAction(device, "select")}
              onStart={() => void runDeviceAction(device, "start")}
              onStop={() => void runDeviceAction(device, "stop")}
            />
          ))
        )}
      </div>

      <button onClick={() => void refresh()}>Refresh Devices</button>
    </section>
  );
}

export function OrientationPanel() {
  const [orientation, setOrientation] = useState<OrientationMode | "unknown">("unknown");
  const [orientationStatus, setOrientationStatus] = useState("Loading...");

  const refreshOrientation = useCallback(async () => {
    try {
      const json = await apiRequest("/api/orientation", { method: "GET", cache: "no-store" });
      const next = json.orientation.orientation;
      setOrientation(next);
      setOrientationStatus(next === "unknown" ? json.orientation.raw || "Unknown" : next);
    } catch (err) {
      setOrientation("unknown");
      setOrientationStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setDeviceOrientation = useCallback(async (next: OrientationMode) => {
    setOrientationStatus("Applying...");
    try {
      const json = await apiRequest("/api/orientation", {
        method: "POST",
        body: { orientation: next },
      });
      const applied = json.orientation.orientation;
      setOrientation(applied);
      setOrientationStatus(applied === "unknown" ? json.orientation.raw || "Unknown" : applied);
    } catch (err) {
      setOrientationStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshOrientation();
  }, [refreshOrientation]);

  return (
    <section className="tool-panel orientation-panel">
      <div className="panel-heading">
        <h2>Orientation</h2>
        <div className="location-status">{orientationStatus}</div>
      </div>
      <div className="segmented-row">
        <button
          className={orientation === "portrait" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("portrait")}
        >
          Portrait
        </button>
        <button
          className={orientation === "landscape" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("landscape")}
        >
          Landscape
        </button>
        <button
          className={orientation === "auto" ? "selected" : ""}
          onClick={() => void setDeviceOrientation("auto")}
        >
          Auto
        </button>
      </div>
    </section>
  );
}

export function NightModePanel() {
  const [nightMode, setNightMode] = useState<NightMode | "unknown">("unknown");
  const [nightModeStatus, setNightModeStatus] = useState("Loading...");

  const refreshNightMode = useCallback(async () => {
    try {
      const json = await apiRequest("/api/night-mode", { method: "GET", cache: "no-store" });
      const next = json.nightMode.mode;
      setNightMode(next);
      setNightModeStatus(next === "unknown" ? json.nightMode.raw || "Unknown" : next);
    } catch (err) {
      setNightMode("unknown");
      setNightModeStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setDeviceNightMode = useCallback(async (next: NightMode) => {
    setNightModeStatus("Applying...");
    try {
      const json = await apiRequest("/api/night-mode", {
        method: "POST",
        body: { mode: next },
      });
      const applied = json.nightMode.mode;
      setNightMode(applied);
      setNightModeStatus(applied === "unknown" ? json.nightMode.raw || "Unknown" : applied);
    } catch (err) {
      setNightModeStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshNightMode();
  }, [refreshNightMode]);

  return (
    <section className="tool-panel night-mode-panel">
      <div className="panel-heading">
        <h2>Theme</h2>
        <div className="location-status">{nightModeStatus}</div>
      </div>
      <div className="segmented-row">
        <button
          className={nightMode === "dark" ? "selected" : ""}
          onClick={() => void setDeviceNightMode("dark")}
        >
          Dark
        </button>
        <button
          className={nightMode === "light" ? "selected" : ""}
          onClick={() => void setDeviceNightMode("light")}
        >
          Light
        </button>
        <button
          className={nightMode === "auto" ? "selected" : ""}
          onClick={() => void setDeviceNightMode("auto")}
        >
          Auto
        </button>
      </div>
    </section>
  );
}

export function FontScalePanel() {
  const [fontScale, setFontScale] = useState<number | null>(null);
  const [fontScaleStatus, setFontScaleStatus] = useState("Loading...");

  const refreshFontScale = useCallback(async () => {
    try {
      const json = await apiRequest("/api/font-scale", { method: "GET", cache: "no-store" });
      setFontScale(json.fontScale.scale);
      setFontScaleStatus(`${Math.round(json.fontScale.scale * 100)}%`);
    } catch (err) {
      setFontScale(null);
      setFontScaleStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setDeviceFontScale = useCallback(async (next: number) => {
    setFontScaleStatus("Applying...");
    try {
      const json = await apiRequest("/api/font-scale", {
        method: "POST",
        body: { scale: next },
      });
      setFontScale(json.fontScale.scale);
      setFontScaleStatus(`${Math.round(json.fontScale.scale * 100)}%`);
    } catch (err) {
      setFontScaleStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshFontScale();
  }, [refreshFontScale]);

  return (
    <section className="tool-panel font-scale-panel">
      <div className="panel-heading">
        <h2>Font Size</h2>
        <div className="location-status">{fontScaleStatus}</div>
      </div>
      <div className="font-scale-row">
        {FONT_SCALE_PRESETS.map((scale) => (
          <button
            key={scale}
            className={fontScale !== null && Math.abs(fontScale - scale) < 0.01 ? "selected" : ""}
            onClick={() => void setDeviceFontScale(scale)}
          >
            {Math.round(scale * 100)}%
          </button>
        ))}
      </div>
    </section>
  );
}

function networkLabel(network: NetworkResponse["network"]): string {
  const state = network.enabled === true ? "on" : network.enabled === false ? "off" : "unknown";
  const wifi = network.wifi && network.wifi !== "unknown" ? `wifi ${network.wifi}` : "wifi ?";
  const mobileData =
    network.mobileData && network.mobileData !== "unknown" ? `data ${network.mobileData}` : "data ?";
  return `${state} (${wifi}, ${mobileData})`;
}

export function NetworkPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [networkStatus, setNetworkStatus] = useState("Loading...");

  const refreshNetwork = useCallback(async () => {
    try {
      const json = await apiRequest("/api/network", { method: "GET", cache: "no-store" });
      setEnabled(json.network.enabled ?? null);
      setNetworkStatus(networkLabel(json.network));
    } catch (err) {
      setEnabled(null);
      setNetworkStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setDeviceNetwork = useCallback(async (next: boolean) => {
    setNetworkStatus("Applying...");
    try {
      const json = await apiRequest("/api/network", {
        method: "POST",
        body: { enabled: next },
      });
      setEnabled(json.network.enabled ?? null);
      setNetworkStatus(networkLabel(json.network));
    } catch (err) {
      setNetworkStatus(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshNetwork();
  }, [refreshNetwork]);

  return (
    <section className="tool-panel network-panel">
      <div className="panel-heading">
        <h2>Network</h2>
        <div className="location-status">{networkStatus}</div>
      </div>
      <div className="segmented-row network-row">
        <button
          className={enabled === true ? "selected" : ""}
          onClick={() => void setDeviceNetwork(true)}
        >
          On
        </button>
        <button
          className={enabled === false ? "selected" : ""}
          onClick={() => void setDeviceNetwork(false)}
        >
          Off
        </button>
      </div>
    </section>
  );
}

function DeviceRow({
  device,
  sessionStatus,
  busy,
  onSelect,
  onStart,
  onStop,
}: {
  device: GridDevice;
  sessionStatus: DeviceGridResponse["sessionStatus"];
  busy: BusyAction | undefined;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const isLiveCurrent = device.current && sessionStatus === "streaming";
  const status = device.current ? (sessionStatus ?? "streaming") : device.state;
  const title = device.kind === "avd" ? "AVD" : device.kind === "emulator" ? "EMU" : "USB";

  return (
    <div className={device.current ? "device-row grid-device-row current" : "device-row grid-device-row"}>
      <button
        type="button"
        className="device-row-main"
        disabled={!device.canSelect || Boolean(busy) || isLiveCurrent}
        onClick={onSelect}
      >
        <span className="device-kind" title={device.kind}>{title}</span>
        <span className="device-name">{device.name}</span>
        <span className="device-subtitle">{device.serial ?? device.avd ?? "not running"}</span>
      </button>
      <div className="device-row-actions">
        <code>{busy ?? status}</code>
        {device.canStart ? (
          <button disabled={Boolean(busy)} onClick={onStart}>
            Start
          </button>
        ) : null}
        {device.canStop ? (
          <button disabled={Boolean(busy)} onClick={onStop}>
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}
