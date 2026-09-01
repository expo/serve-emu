# Review follow-ups (temporary)

> Temporary review artifact: remove this file before merging the pull request.

This document records the findings from the standards and specification reviews of the runtime stream-resolution work. It intentionally includes cross-repository findings so that they are not lost while the `serve-emu` and host-monorepo changes are reviewed separately.

## Standards review

### Capability contract is intentionally breaking

The host monorepo changes `DeviceCapabilities.streamSettings` from a boolean to a per-setting capability map. The only client is being updated in the same change, so backward compatibility with `streamSettings: true` is not required.

Remaining cleanup in the host monorepo: two dashboard test fixtures infer `streamSettings: false` as `boolean` instead of the literal `false`. Give the fixtures an explicit type or use `false as const`.

### Changeset scope and stale publication guidance

`@expo/hub-client` is private and should not appear in the release changeset. The current changeset correctly includes only `expo-device-hub`; no package needs to be removed from it.

The host monorepo's `.changeset/README.md` is stale because it says both packages are published. Update it to list only `expo-device-hub`.

### Public API documentation is stale

Document `GET /api/stream-settings` and `PATCH /api/stream-settings` in:

- `packages/serve-emu/README.md`, which is included in the published package.
- The repository-level `README.md`, whose HTTP API section currently diverges from the package README.

The documentation should cover the device query, response and patch shape, validation bounds, `maxDimension: 0` semantics, capture restart behavior, rollback, and errors.

Also update the exported host-monorepo type comment that currently describes stream settings as a `serve-sim`-only capability.

## Specification review

### Capture replacement deadline (resolved by the current `expo` base)

Rollback already exists: if the replacement capture fails, `serve-emu` starts scrcpy again with the previous settings. Partial startup failures clean up their sockets, process, and ADB forward, and stop races are covered by tests.

The original review was against the pre-rebase submodule revision. On that revision, only socket discovery and TCP connection were bounded; synchronous ADB calls, an optional server download, and the video-preamble read could wait indefinitely. While that happened, `captureRestarting` remained true, queued settings requests could not finish, input was rejected, and rollback could not begin.

Current `expo` already contains the robust scrcpy lifecycle work: startup stages have deadlines, `startScrcpy` accepts an abort signal, and timeout failures use the normal cleanup path. The rebased resolution implementation also awaits the old capture cleanup before opening its replacement. A possible refinement is to connect middleware `stop()` to a restart-specific abort controller so shutdown cancels immediately instead of waiting for the bounded startup to settle and then closing the late capture.

### Active recorded-session replay is interrupted

Recorded events remain stored, but an active replay ends when a resolution restart causes its in-flight gesture dispatch to reject. The smallest safe behavior is to return `409 Conflict` for a settings PATCH while replay is active, allowing the replay to finish and the caller to retry. Transparently retrying a gesture is unsafe because it may already have been partially delivered.

### Host device can change while a PATCH is in flight

The host hook can briefly send a settings PATCH for the previous device after device selection changes. Bind each request to the device identity that created it and ignore or cancel stale completions.

### Failed PATCH rollback is not reflected immediately in host state

After an optimistic host update fails, local state can temporarily roll back to an older snapshot rather than the server's authoritative value. The periodic poll eventually corrects it. On failure, fetch current settings immediately or otherwise guard rollback by request generation.

### Older backends show an unavailable control

The Android client initially advertises `maxDimension` support before proving that the backend implements the settings endpoint. Against an older backend, the control is visible but disabled after the initial request fails. Prefer advertising the capability only after endpoint discovery, or expose an explicit unsupported state.

### Direct coverage gaps

Add focused coverage for:

- WebRTC publisher/client continuity across capture replacement.
- The host hook's optimistic update, rollback, polling, and device-switch behavior.
- Device isolation of the settings endpoint.
- Updated touch dimensions after capture replacement.

### Endpoint scope exceeds the requested UI feature

The API accepts `h264Bitrate` and `h264Fps` as well as `maxDimension`, although the requested Android UI exposes only resolution. This is internally consistent and useful for future controls, but it increases the public API surface. Either keep and document all three fields or narrow the endpoint to `maxDimension` until the other controls are intentionally supported.

### Standalone-server parity after the `expo` rebase

The Hub mounts the multi-device middleware router, where this change adds the settings endpoint. The current `expo` branch has a separate standalone-server request pipeline rather than mounting that router, so the standalone CLI does not inherit the endpoint automatically. Decide before merge whether the public contract is middleware-only or add equivalent capture-replacement support to the standalone device-session implementation.
