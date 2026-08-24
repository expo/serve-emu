# Releasing `@expo/serve-emu`

Releases are cut from the `expo` branch with the **Release @expo/serve-emu**
GitHub Actions workflow. The workflow bumps the package version, runs the test
and typecheck suites, builds and smoke-tests the exact npm tarball, atomically
pushes the release commit and tag, and publishes with npm trusted publishing.

The repository must have a protected `npm-release` GitHub environment. On npm,
configure `@expo/serve-emu` with this trusted publisher:

- Provider: GitHub Actions
- Organization: `expo`
- Repository: `serve-emu`
- Workflow: `release.yml`
- Environment: `npm-release`

## First publish

npm requires a package to exist before a trusted publisher can be configured.
For the one-time bootstrap, after this publishing setup lands on `expo`:

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
mkdir -p release
npm pack --workspace packages/serve-emu --pack-destination release
npm publish release/expo-serve-emu-0.0.3.tgz --access public --provenance=false
```

Run the bootstrap publish from an npm account that can publish to the `@expo`
scope and satisfies the organization's 2FA policy. Then configure the trusted
publisher above. All subsequent releases use the GitHub Actions workflow and
do not need an npm token. The bootstrap version is the only release without a
provenance attestation because npm cannot establish OIDC trust until the package
exists.
