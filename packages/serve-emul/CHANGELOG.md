# Changelog

All notable changes to `serve-emul` are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- `patch` for fixes and small internal improvements
- `minor` for backwards-compatible user-facing features or APIs
- `major` for breaking CLI, HTTP API, WebSocket protocol, package, or runtime behavior

## 1.0.0 - 2026-07-11

### Breaking

- Define `serve-emul` as a CLI-only package with an empty export map. Root and
  deep JavaScript/TypeScript imports are now blocked; the installed
  `serve-emul` executable and documented runtime HTTP/WebSocket APIs remain the
  supported surfaces.

### Changed

- Remove confirmed internal dead helpers, fields, exports, and unreachable UI
  branches now that repository implementation files are no longer accidental
  package APIs. Session snapshots no longer include the always-true
  `recording` field.
- Add packed-tarball consumer tests and Knip static analysis to the package
  validation pipeline.
- Apply the required major-version bump from 0.0.4 to 1.0.0 for the package
  resolution compatibility change.

## 0.0.4 - 2026-06-21

### Added

- Release helper for patch, minor, major, and exact-version bumps.
- Release validation script that runs tests, server typecheck, UI typecheck, and the production UI build.

### Changed

- Bump the package version from 0.0.3 to 0.0.4.
- Document the release process and align README status text with the package version.

## 0.0.3 - 2026-06-21

### Added

- Device orientation, night mode, font scale, and multi-device routing controls.
- Logcat streaming, accessibility inspection, app management, route playback, and session replay workflows.
- H.264 WebSocket streaming with WebCodecs browser decoding and REST/WebSocket input controls.
