---
"@runfusion/fusion": minor
---

summary: Add beta and stable release channels — pick your update track in Settings or with `fn update --channel <stable|beta>`.
category: feature
dev: New `updateChannel` global setting (default `stable`). Betas are cut from `main` via `pnpm release --channel beta` (changesets pre-mode) to the npm `beta` dist-tag as GitHub prereleases; stable releases are cut from the `release` branch to `latest`. CLI/dashboard/desktop update surfaces share `compareVersions`/`isVersionNewer`/`resolveUpdateTargetVersion` from `@fusion/core` (full SemVer precedence incl. prerelease); installs pin exact versions instead of `@latest`.
