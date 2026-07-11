import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ForegroundApp } from "../../shared/api-contracts";
import {
  apiRequest,
  type ApiSuccessResponse,
} from "../lib/api-client";

type AppApiResult =
  | ApiSuccessResponse<"/api/apps/install", "POST">
  | ApiSuccessResponse<"/api/files/import", "POST">
  | ApiSuccessResponse<"/api/apps/launch", "POST">
  | ApiSuccessResponse<"/api/apps/clear", "POST">
  | ApiSuccessResponse<"/api/apps/force-stop", "POST">
  | ApiSuccessResponse<"/api/apps/grant", "POST">;

function outputFor(result: AppApiResult): string {
  return result.output || "OK";
}

function isApk(file: File): boolean {
  return file.name.toLowerCase().endsWith(".apk") || file.type === "application/vnd.android.package-archive";
}

export function AppManagementPanel() {
  const apkRef = useRef<HTMLInputElement>(null);
  const [packageName, setPackageName] = useState("");
  const [activity, setActivity] = useState("");
  const [permission, setPermission] = useState("android.permission.POST_NOTIFICATIONS");
  const [status, setStatus] = useState("Ready");
  const [dragOver, setDragOver] = useState(false);
  const [foreground, setForeground] = useState<ForegroundApp | null>(null);
  const [foregroundError, setForegroundError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const json = await apiRequest("/api/foreground", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        setForeground(json.app);
        setForegroundError(null);
      } catch (err) {
        if (!controller.signal.aborted) {
          setForeground(null);
          setForegroundError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void refresh();
    return () => controller.abort();
  }, []);

  const run = async (label: string, request: () => Promise<AppApiResult>) => {
    setStatus(`${label}...`);
    try {
      const result = await request();
      setStatus(outputFor(result));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const uploadFile = async (file: File) => {
    const apk = isApk(file);
    await run(apk ? "Installing" : "Importing", async () => {
      const form = new FormData();
      form.set(apk ? "apk" : "file", file);
      return apk
        ? apiRequest("/api/apps/install", { method: "POST", body: form })
        : apiRequest("/api/files/import", { method: "POST", body: form });
    });
  };

  const install = async () => {
    const file = apkRef.current?.files?.[0];
    if (!file) {
      setStatus("Choose an APK, image, or video first");
      return;
    }
    await uploadFile(file);
    if (apkRef.current) apkRef.current.value = "";
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void (async () => {
      for (const file of files) {
        await uploadFile(file);
      }
    })();
  };

  const packageBody = () => ({ packageName: packageName.trim() });

  return (
    <section className="tool-panel app-management-panel">
      <div className="panel-heading">
        <h2>Apps</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="foreground-card">
        <div className="foreground-title">
          <span>{foreground?.label || foreground?.packageName || "No foreground app"}</span>
          {foreground?.packageName && (
            <button
              type="button"
              onClick={() => {
                setPackageName(foreground.packageName || "");
                setActivity(foreground.activity || "");
              }}
            >
              Use
            </button>
          )}
        </div>
        {foreground?.packageName ? (
          <dl>
            <div>
              <dt>Package</dt>
              <dd>{foreground.packageName}</dd>
            </div>
            <div>
              <dt>Activity</dt>
              <dd>{foreground.activity || "—"}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>
                {foreground.versionName || "—"}
                {foreground.versionCode ? ` (${foreground.versionCode})` : ""}
              </dd>
            </div>
            <div>
              <dt>PID</dt>
              <dd>{foreground.pid ?? "—"}</dd>
            </div>
            <div>
              <dt>Debuggable</dt>
              <dd>{foreground.debuggable == null ? "—" : foreground.debuggable ? "yes" : "no"}</dd>
            </div>
          </dl>
        ) : (
          <div className="foreground-empty">{foregroundError || "Waiting for app focus..."}</div>
        )}
      </div>
      <div
        className={dragOver ? "file-drop active" : "file-drop"}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <span>Drop APK, image, or video</span>
        <small>APK installs; media is pushed to device storage.</small>
      </div>
      <input
        ref={apkRef}
        type="file"
        accept=".apk,application/vnd.android.package-archive,image/*,video/*"
      />
      <button className="primary-action" onClick={() => void install()}>
        Upload Selected File
      </button>
      <label className="stacked-field">
        Package
        <input
          onChange={(e) => setPackageName(e.currentTarget.value)}
          placeholder="com.example.app"
          value={packageName}
        />
      </label>
      <label className="stacked-field">
        Activity
        <input
          onChange={(e) => setActivity(e.currentTarget.value)}
          placeholder=".MainActivity"
          value={activity}
        />
      </label>
      <div className="panel-actions app-actions">
        <button
          onClick={() =>
            void run("Launching", () =>
              apiRequest("/api/apps/launch", {
                method: "POST",
                body: { ...packageBody(), activity: activity.trim() || undefined },
              }),
            )
          }
        >
          Launch
        </button>
        <button
          onClick={() =>
            void run("Clearing", () =>
              apiRequest("/api/apps/clear", { method: "POST", body: packageBody() }),
            )
          }
        >
          Clear
        </button>
        <button
          onClick={() =>
            void run("Stopping", () =>
              apiRequest("/api/apps/force-stop", { method: "POST", body: packageBody() }),
            )
          }
        >
          Stop
        </button>
      </div>
      <label className="stacked-field">
        Permission
        <input
          onChange={(e) => setPermission(e.currentTarget.value)}
          placeholder="android.permission.POST_NOTIFICATIONS"
          value={permission}
        />
      </label>
      <button
        onClick={() =>
          void run("Granting", () =>
            apiRequest("/api/apps/grant", {
              method: "POST",
              body: { ...packageBody(), permission: permission.trim() },
            }),
          )
        }
      >
        Grant Permission
      </button>
    </section>
  );
}
