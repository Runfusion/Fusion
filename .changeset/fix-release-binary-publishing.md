---
"@runfusion/fusion": patch
---

Fix the Binary Release workflow so platform binaries publish to GitHub Releases again:

- The release job now tolerates a single failing build leg instead of being skipped, which previously suppressed all assets.
- The node_modules cache key includes CPU arch so arm64 runners no longer restore x64 native deps (fixes the `@rollup/rollup-linux-arm64-gnu` build crash).
- The macOS and Windows CLI signing steps are skipped gracefully when their certificate secrets are absent, so unsigned binaries still publish.
- Desktop packaging now invokes `electron-builder` directly via `pnpm exec` instead of the `dist:*` scripts: pnpm leaked the `--` separator into script args, which made electron-builder ignore `--publish never` (auto-publishing to the wrong repo and 404ing) and drop the Linux `--x64 --arm64` flags.
- The desktop build spawns workspace `.cmd` bins with a shell on Windows, fixing the `spawn EINVAL` failure.
- The desktop package declares an `author` with email so the Linux `.deb` target (fpm) can build.
- A workflow_dispatch run now builds and uploads binaries as artifacts for validation without creating a release (release creation is gated to tag pushes).
- The dependency-graph plugin build uses a cross-platform copy step that no longer breaks the Windows desktop build.
