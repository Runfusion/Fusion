# Releasing

This project uses [changesets](https://github.com/changesets/changesets) for automated versioning and release management. Fusion Pro releases are distributed through private channels:

1. **Private package registry** — `@runfusion/fusion` is published by `version.yml` to GitHub Packages by default
2. **Private workflow artifacts** — platform binaries are built by `release.yml` when a version tag is pushed and retained as workflow artifacts

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

A markdown file will be created in the `.changeset/` directory. Commit this file along with your code changes.

### 2. Version PR is created manually

Run the manual `version.yml` workflow to open or update a **"Version Packages"** pull request. This PR:

- Consumes all pending changeset files
- Bumps package versions according to the changeset declarations
- Generates/updates `CHANGELOG.md` files for affected packages

### 3. Merge the Version PR to release

When you merge the Version Packages PR:

- The `version.yml` workflow detects that all changesets have been consumed
- It builds all packages and publishes `@runfusion/fusion` to the private package registry
- It creates a git tag `v{version}` based on the Fusion CLI package version
- The tag push triggers `release.yml`, which:
  - Builds platform-specific CLI binaries for Linux x64, Linux arm64, macOS arm64, and Windows x64
  - Builds desktop artifacts for Windows, macOS, and Linux
  - Signs macOS binaries (codesign + notarization) and Windows binaries (Authenticode)
  - Generates SHA256 checksums for all binaries
  - Uploads the collected binaries and checksums as private workflow artifacts

## Release channels

| Channel | Workflow | Trigger | Output |
|---------|----------|---------|--------|
| Private package | `version.yml` | Manual workflow | `@runfusion/fusion` in GitHub Packages |
| Private binaries | `release.yml` | Version tag (`v*`) | Signed platform binaries + checksums as workflow artifacts |

## Platform binaries

| Platform | Binary name | Signed |
|----------|------------|--------|
| Linux x64 | `fusion-linux-x64` | — |
| macOS arm64 | `fusion-darwin-arm64` | ✓ (codesign + notarization) |
| Windows x64 | `fusion-windows-x64.exe` | ✓ (Authenticode) |

> macOS Intel (`darwin-x64`) is intentionally not shipped: the CLI is Apple-Silicon-only because `macos-13` GitHub runners are too scarce to build reliably. The desktop macOS DMG/ZIP remains universal.

## Testing binary builds

Use the **Test Release** workflow (`test-release.yml`) to manually test binary builds without creating release artifacts:

1. Go to **Actions** → **Test Release** → **Run workflow**
2. The workflow builds all 4 platform binaries, runs smoke tests, and uploads artifacts
3. Download the `all-binaries` artifact to inspect the output

## Manual release (fallback)

If you need to build binary artifacts manually, you can still push a version tag directly:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This will trigger `release.yml` to build binaries and upload private workflow artifacts. Package publishing is handled separately by `version.yml` and is not triggered by a manual tag push.

For a full local release, use the source-of-truth command:

```bash
FUSION_RELEASE_PACKAGE_REGISTRY=https://npm.pkg.github.com \
NODE_AUTH_TOKEN=<token-with-package-write> \
pnpm release --yes
```

The local script validates the private registry target before versioning, building, committing, tagging, or publishing. It refuses the public npm registry and does not create public Homebrew or GitHub Release distribution side effects.

## Available scripts

| Script | Description |
|--------|-------------|
| `pnpm changeset` | Add a new changeset |
| `pnpm changeset status` | Check pending changesets |
| `pnpm release` | Local interactive release: previews changesets, lets you accept or override the proposed version, then bumps + builds + publishes + tags |
| `pnpm release --yes` | Same, but auto-accepts the proposed version and skips the final confirmation |
| `pnpm release --dry-run` | Preview only — show changesets, proposed version, private package target, and prompt for override, then exit before any file/git/package changes |
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

The following packages are **internal** and are **not published as separate packages**:

- `@fusion/core` — Core domain model and task store
- `@fusion/dashboard` — Web UI and API server
- `@fusion/engine` — AI agents and orchestration
- `@fusion/plugin-sdk` — Plugin development SDK
- `@fusion-plugin-examples/*` — Example plugins

These packages have `private: true` in their `package.json` and no public publish access. Only the bundled `@runfusion/fusion` package is published to the configured private package registry.
