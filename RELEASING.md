# Releasing

This project uses [changesets](https://github.com/changesets/changesets) for automated versioning and release management. Releases are distributed through two channels:

1. **npm packages** — published automatically via `version.yml` using changesets
2. **GitHub Release with platform binaries** — built and uploaded via `release.yml` when a version tag is pushed

## How it works

### 1. Add a changeset

When you make a change that should be included in a release, add a changeset:

```bash
pnpm changeset
```

This will prompt you to:
- Select which packages are affected
- Choose the semver bump type (patch, minor, major)
- Write a summary of the change

Then edit the created changeset file to use the structured body format:

```markdown
---
"@runfusion/fusion": minor
---

summary: Add a Command Center productivity control for LOC backfills.
category: feature
dev: Uses the new `fn_backfill_loc` tool; settings key `commandCenter.locBackfill`.
```

Fields:
- `summary` (required) — one line, user-facing, max 120 chars.
- `category` (required) — one of: `feature`, `fix`, `breaking`, `security`, `performance`, `internal`.
- `dev` (optional) — developer/migration detail.

A markdown file will be created in the `.changeset/` directory. Commit this file along with your code changes. Validate with `pnpm check:changesets`.

### 2. Version PR is created automatically

When changesets are merged to `main`, the `version.yml` workflow automatically opens (or updates) a **"Version Packages"** pull request. This PR:

- Consumes all pending changeset files
- Bumps package versions according to the changeset declarations
- Generates/updates `CHANGELOG.md` files for affected packages
- Distills the version's changeset summaries into grouped, end-user-facing release notes in the root `CHANGELOG.md` via Claude (`claude -p --model sonnet`): a **Highlights** section (top 3–5) plus category groups, and prints an engagement-oriented X draft (≤280 chars) after a local release

### 3. Merge the Version PR to release

When you merge the Version Packages PR:

- The `version.yml` workflow detects that all changesets have been consumed
- It builds all packages and publishes them to **npm** with provenance attestation
- It creates a git tag `v{version}` based on the `kb` CLI package version
- The tag push triggers `release.yml`, which:
  - Builds platform-specific binaries for Linux x64, macOS x64, macOS arm64, and Windows x64
  - Builds Android release assets: signed `fusion-android-release.apk` + `fusion-android-release.aab` when Android signing secrets are configured, otherwise unsigned debug `fusion-android.apk`
  - Signs macOS binaries (codesign + notarization), Windows binaries (Authenticode), and Android release artifacts when keystore secrets are available
  - Generates SHA256 checksums for all binaries and Android artifacts
  - Creates a **GitHub Release** with all binaries, Android artifacts, and checksums attached

## Release tracks: beta and stable

Fusion ships on two tracks. Users pick theirs with the `updateChannel` global setting (Settings → General → Release channel) or `fn update --channel <stable|beta>`.

| Track | Cut from | Version shape | npm dist-tag | GitHub Release | Homebrew |
|-------|----------|---------------|--------------|----------------|----------|
| beta | `main` | `X.Y.Z-beta.N` | `beta` | prerelease | — |
| stable | `release` branch | `X.Y.Z` | `latest` | latest | bumped |

### Beta release (from `main`)

```bash
pnpm release                  # prompts for the channel; beta is the default answer
pnpm release --channel beta   # explicit, no prompt
```

The script auto-enters changesets pre-mode (`.changeset/pre.json`, tag `beta`) the first time, versions to the next `-beta.N`, publishes with an explicit `--tag beta`, tags `vX.Y.Z-beta.N` (the tag push builds binaries and marks the GitHub Release as a prerelease), and skips the Homebrew tap and X draft. Changeset `.md` files are *preserved* through beta versioning — pre-mode records them in `pre.json` so the eventual stable release aggregates everything.

### Promoting to stable (from the `release` branch)

1. Fast-forward/merge `release` to the chosen beta's commit on `main`:
   ```bash
   git checkout release && git merge --ff-only vX.Y.Z-beta.N
   ```
   (First-time bootstrap: `git branch release main && git push -u origin release`.)
2. Run the stable release there:
   ```bash
   pnpm release --channel stable   # or answer "stable" at the channel prompt
   ```
   The script exits pre-mode, versions to the clean `X.Y.Z` with the aggregated changelog, publishes to `latest`, marks the GitHub Release latest, and bumps the Homebrew tap.
3. Back-merge `release` into `main` (the script prints the exact commands). This carries the consumed changesets, changelogs, version bump, and pre.json removal back — without it, the next beta double-releases old changesets.

### Hotfixes

Commit on `release` (or a worktree branched from it), add a changeset, run `pnpm release`, then cherry-pick the fix back to `main`.

### Channel semantics for users

- `stable` follows the npm `latest` dist-tag only — betas are invisible.
- `beta` follows the semver-max of `latest` and `beta`, so beta users are offered each promoted stable once it overtakes their prerelease.
- Switching beta → stable never downgrades; the user stays on the installed beta until the next stable passes it. `fn update --channel stable --force` is the explicit downgrade.
- Desktop beta builds emit `beta*.yml` electron-updater manifests; the desktop app selects them when `updateChannel` is `beta` (`allowPrerelease` + channel).

## Distribution channels

| Channel | Workflow | Trigger | Output |
|---------|----------|---------|--------|
| npm | `version.yml` (stable only) or `pnpm release` | Manual | npm packages with provenance (CI) |
| GitHub Release | `release.yml` | Version tag (`v*`; `v*-beta.N` → prerelease) | Signed platform binaries, Android APK/AAB + checksums |

## Platform binaries

| Platform | Binary name | Signed |
|----------|------------|--------|
| Linux x64 | `fusion-linux-x64` | — |
| macOS arm64 | `fusion-darwin-arm64` | ✓ (codesign + notarization) |
| Windows x64 | `fusion-windows-x64.exe` | ✓ (Authenticode) |
| Android | `fusion-android-release.apk`, `fusion-android-release.aab` | ✓ when Android keystore secrets are configured |
| Android fallback | `fusion-android.apk` | — (debug/unsigned APK when Android keystore secrets are absent) |

> macOS Intel (`darwin-x64`) is intentionally not shipped: the CLI is Apple-Silicon-only because `macos-13` GitHub runners are too scarce to build reliably. The desktop macOS DMG/ZIP remains universal.

## Android release signing

`release.yml` and the tag-less `test-release.yml` rehearsal workflow publish signed Android release artifacts when all Android signing secrets are configured:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded `.jks` / `.keystore` file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Encode the keystore before saving it as a GitHub Actions secret:

```bash
base64 -w0 release.keystore
```

The Android native project under `packages/mobile/android/` is generated and gitignored, so CI does not commit signing configuration into Gradle files. Instead, the release job injects signing at build time with Android Gradle Plugin `android.injected.signing.*` properties, builds `assembleRelease` and `bundleRelease`, verifies the APK signature, and uploads `fusion-android-release.apk`, `fusion-android-release.aab`, and matching `.sha256` files. If `ANDROID_KEYSTORE_BASE64` is absent, the workflow preserves the secret-free path by building the unsigned debug APK as `fusion-android.apk` with `fusion-android.apk.sha256`.

Automated Play Store / Play Console upload is intentionally out of scope for the release pipeline right now. It needs a Google service-account JSON secret, a published Play listing, and fastlane or `r0adkll/upload-google-play` wiring; that work is tracked separately in FN-7043 while Fusion remains sideload-first for pre-1.0 Android distribution.

## Testing binary builds

Use the **Test Release** workflow (`test-release.yml`) to manually test binary builds without creating a real release:

1. Go to **Actions** → **Test Release** → **Run workflow**
2. The workflow builds all 4 platform binaries plus the Android APK/AAB path (signed when Android signing secrets are available, unsigned debug APK otherwise), runs smoke tests, and uploads artifacts
3. Download the `all-binaries` artifact to inspect the output

## Manual release (fallback)

If you need to release manually, you can still push a version tag directly:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This will trigger `release.yml` to build binaries and create a GitHub Release. Note: npm publishing is handled separately by `version.yml` and won't be triggered by a manual tag push.

## Available scripts

| Script | Description |
|--------|-------------|
| `pnpm changeset` | Add a new changeset |
| `pnpm changeset status` | Check pending changesets |
| `pnpm release` | Local interactive release: previews changesets, lets you accept or override the proposed version, then bumps + builds + publishes + tags; Claude authors Highlights + a ≤280-char engagement X draft (soft deterministic fallback if Claude is offline) |
| `pnpm release --yes` | Same, but auto-accepts the proposed version and skips the final confirmation |
| `pnpm release --dry-run` | Preview only — show changesets, proposed version, and Claude-authored X draft preview, then exit before any file/git/npm changes |
| `pnpm release --channel beta` | Beta release from `main`: pre-mode version `X.Y.Z-beta.N`, npm dist-tag `beta`, GitHub prerelease; no Homebrew/X draft |
| `pnpm release --channel stable` | Stable release: requires the `release` branch, publishes `latest`, marks the GitHub Release latest |

Without `--channel`, `pnpm release` prompts for the channel and **defaults to beta** (also the silent default with `--yes` or a non-interactive dry-run). Stable releases are always an explicit choice.
| `pnpm release:version` | Apply changesets and bump versions (used by CI) |
| `pnpm --filter @runfusion/fusion build:exe` | Build binary for current platform |
| `pnpm --filter @runfusion/fusion build:exe -- --target <target>` | Cross-compile for a specific platform |
| `pnpm --filter @runfusion/fusion build:exe:all` | Build binaries for all platforms |

## Tips

- Every user-facing change should have a changeset — CI will remind you if one is missing
- You can add multiple changesets per PR if you're making changes to multiple packages
- Changeset files are automatically deleted when versions are bumped
- CI verifies binary compilation on every push/PR to catch build regressions early
- If your project enables `completionDocumentationMode: "changeset"`, triage specs will explicitly require `.changeset/*.md` completion artifacts for relevant tasks; keep this aligned with your repo's release convention.

## Internal packages

The following packages are **internal** and are **not published to npm**:

- `@fusion/core` — Core domain model and task store
- `@fusion/dashboard` — Web UI and API server
- `@fusion/engine` — AI agents and orchestration
- `@fusion/plugin-sdk` — Plugin development SDK
- `@fusion-plugin-examples/*` — Example plugins

These packages have `private: true` in their `package.json` and are listed in the `.changeset/config.json` `ignore` array to prevent accidental publishing. Only the `@runfusion/fusion` package is published to npm.
