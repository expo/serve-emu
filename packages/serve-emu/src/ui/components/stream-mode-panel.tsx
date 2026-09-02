import { useCallback, useEffect, useRef, useState } from "react";
import {
  GRPC_IMAGE_MODES,
  STREAM_MODES,
  type GrpcImageMode,
  type StreamMode,
  type StreamModeResponse,
} from "../../shared/api-contracts";
import { apiRequest } from "../lib/api-client";
import {
  deviceSessionStore,
  useDeviceSessionSnapshot,
} from "../lib/device-session-store";
import { usePoll } from "../lib/use-poll";

type LoadedStreamMode = StreamModeResponse & { revision: number };

const OPTION_COPY = {
  scrcpy: {
    label: "scrcpy",
    description: "On-device capture",
  },
  "grpc-screenshot": {
    label: "gRPC screenshot",
    description: "Emulator host capture",
  },
} satisfies Record<StreamMode, {
  label: string;
  description: string;
}>;

const OPTIONS = STREAM_MODES.map((mode) => ({ mode, ...OPTION_COPY[mode] }));
const GRPC_IMAGE_MODE_COPY = {
  png: {
    label: "PNG",
    description: "Compressed in-band images",
  },
  mmap: {
    label: "MMAP",
    description: "Shared-memory raw pixels",
  },
} satisfies Record<GrpcImageMode, {
  label: string;
  description: string;
}>;
const GRPC_IMAGE_OPTIONS = GRPC_IMAGE_MODES.map((mode) => ({
  mode,
  ...GRPC_IMAGE_MODE_COPY[mode],
}));
const STREAM_MODE_POLL_INTERVAL_MS = 4_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GrpcImageModeSelectorProps = {
  value: GrpcImageMode;
  disabled: boolean;
  onChange: (mode: GrpcImageMode) => void;
};

export function GrpcImageModeSelector({
  value,
  disabled,
  onChange,
}: GrpcImageModeSelectorProps) {
  return (
    <fieldset
      className="stream-mode-fieldset grpc-image-mode-fieldset"
      disabled={disabled}
      aria-describedby="stream-mode-help"
    >
      <legend>gRPC image mode</legend>
      <div className="stream-mode-options">
        {GRPC_IMAGE_OPTIONS.map((option) => (
          <label className="stream-mode-option" key={option.mode}>
            <input
              type="radio"
              name="grpc-image-mode"
              value={option.mode}
              checked={value === option.mode}
              onChange={() => onChange(option.mode)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function StreamModePanel() {
  const deviceSession = useDeviceSessionSnapshot();
  const actionId = useRef(0);
  const [loaded, setLoaded] = useState<LoadedStreamMode | null>(null);
  const [feedback, setFeedback] = useState<{
    revision: number;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () => () => {
      actionId.current += 1;
    },
    [],
  );

  const { refresh } = usePoll({
    poll: ({ signal }) =>
      apiRequest("/api/stream-mode", {
        method: "GET",
        cache: "no-store",
        signal,
      }),
    onResult: (response, context) => {
      deviceSessionStore.applyHealth(response);
      const current = deviceSessionStore.getSnapshot();
      const revision = current.serial === response.serial
        ? current.revision
        : context.key;
      setLoaded({ ...response, revision });
      setFeedback({ revision, message: "Ready" });
    },
    onError: (error, context) => {
      setLoaded((current) =>
        current?.revision === context.key ? current : null
      );
      setFeedback({ revision: context.key, message: errorMessage(error) });
    },
    intervalMs: STREAM_MODE_POLL_INTERVAL_MS,
    pollKey: deviceSession.revision,
    enabled: !deviceSession.transitioning,
  });

  const selectionReady =
    !deviceSession.transitioning && loaded?.revision === deviceSession.revision;
  const displayedMode = busy ? loaded?.mode ?? null : selectionReady ? loaded.mode : null;
  const availableModes =
    busy || selectionReady ? loaded?.availableModes ?? [] : [];
  const status =
    busy || deviceSession.transitioning
      ? "Switching…"
      : feedback?.revision === deviceSession.revision
        ? feedback.message
        : "Loading…";

  const apply = useCallback(
    async (
      nextMode: StreamMode,
      nextGrpcImageMode: GrpcImageMode,
    ) => {
      if (
        busy ||
        !selectionReady ||
        !loaded ||
        (
          nextMode === loaded.mode &&
          nextGrpcImageMode === loaded.grpcImageMode
        ) ||
        !loaded.availableModes.includes(nextMode)
      ) {
        return;
      }

      const previous = loaded;
      const id = ++actionId.current;
      setBusy(true);
      deviceSessionStore.beginTransition(previous.serial);

      let response: StreamModeResponse | null = null;
      let failure: unknown = null;
      try {
        response = await apiRequest("/api/stream-mode", {
          method: "PUT",
          body: nextMode === "grpc-screenshot"
            ? { mode: nextMode, grpcImageMode: nextGrpcImageMode }
            : { mode: nextMode },
        });
      } catch (error) {
        failure = error;
      } finally {
        deviceSessionStore.endTransition();
      }

      let currentSession = deviceSessionStore.getSnapshot();
      if (currentSession.serial === previous.serial) {
        deviceSessionStore.applyHealth(response ?? previous);
        currentSession = deviceSessionStore.getSnapshot();
      }

      if (id !== actionId.current) return;

      if (
        response &&
        !currentSession.transitioning &&
        currentSession.serial === response.serial
      ) {
        setLoaded({ ...response, revision: currentSession.revision });
        setFeedback({ revision: currentSession.revision, message: "Ready" });
      } else if (
        failure !== null &&
        !currentSession.transitioning &&
        currentSession.serial === previous.serial
      ) {
        setLoaded({ ...previous, revision: currentSession.revision });
        setFeedback({
          revision: currentSession.revision,
          message: errorMessage(failure),
        });
      } else {
        refresh();
      }
      setBusy(false);
    },
    [busy, loaded, refresh, selectionReady],
  );

  const grpcAvailable = availableModes.includes("grpc-screenshot");
  const grpcSelected = displayedMode === "grpc-screenshot";
  const grpcImageModeDisabled =
    busy ||
    deviceSession.transitioning ||
    !selectionReady ||
    !grpcSelected;
  const help = busy || deviceSession.transitioning
    ? "Changing the stream capture and reconnecting the browser stream…"
    : !selectionReady
      ? status === "Loading…"
        ? "Checking the available stream sources…"
        : "Stream source details are unavailable."
      : !grpcAvailable
        ? "gRPC screenshot is available only for Android Emulator devices."
        : loaded.mode === "grpc-screenshot"
          ? loaded.grpcImageMode === "mmap"
            ? "Frames use the emulator's shared-memory MMAP path; input uses gRPC."
            : "Frames use in-band PNG images; input uses gRPC."
          : "Frames and input use the scrcpy server on the device.";

  return (
    <section className="tool-panel stream-mode-panel">
      <div className="panel-heading">
        <h2>Stream Source</h2>
        <div
          className="location-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </div>
      </div>
      <fieldset
        className="stream-mode-fieldset"
        aria-busy={busy || deviceSession.transitioning || !selectionReady}
        aria-describedby="stream-mode-help"
      >
        <legend className="visually-hidden">Stream source</legend>
        <div className="stream-mode-options">
          {OPTIONS.map((option) => {
            const disabled =
              busy ||
              deviceSession.transitioning ||
              !selectionReady ||
              !availableModes.includes(option.mode);
            return (
              <label className="stream-mode-option" key={option.mode}>
                <input
                  type="radio"
                  name="stream-mode"
                  value={option.mode}
                  checked={displayedMode === option.mode}
                  disabled={disabled}
                  onChange={() => {
                    if (loaded) void apply(option.mode, loaded.grpcImageMode);
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {grpcSelected && loaded ? (
        <GrpcImageModeSelector
          value={loaded.grpcImageMode}
          disabled={grpcImageModeDisabled}
          onChange={(mode) => void apply("grpc-screenshot", mode)}
        />
      ) : null}
      <p className="stream-mode-help" id="stream-mode-help">
        {help}
      </p>
    </section>
  );
}
