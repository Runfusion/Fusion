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

A markdown file will be created in the `.changeset/` directory. Commit this file along with your code changes.

### 2. Version PR is created automatically

When changesets are merged to `main`, the `version.yml` workflow automatically opens (or updates) a **"Version Packages"** pull request. This PR:

- Consumes all pending changeset files
- Bumps package versions according to the changeset declarations
- Generates/updates `CHANGELOG.md` files for affected packages

### 3. Merge the Version PR to release

When you merge the Version Packages PR:

- The `version.yml` workflow detects that all changesets have been consumed
- It builds all packages and publishes them to **npm** with provenance attestation
- It creates a git tag `v{version}` based on the `kb` CLI package version
- The tag push triggers `release.yml`, which:
  - Builds platform-specific binaries for Linux x64, macOS x64, macOS arm64, and Windows x64
  - Signs macOS binaries (codesign + notarization) and Windows binaries (Authenticode)
  - Generates SHA256 checksums for all binaries
  - Creates a **GitHub Release** with all binaries and checksums attached

## Release channels

| Channel | Workflow | Trigger | Output |
|---------|----------|---------|--------|
| npm | `version.yml` | Push to `main` | npm packages with provenance |
| GitHub Release | `release.yml` | Version tag (`v*`) | Signed platform binaries + checksums |

## Platform binaries

| Platform | Binary name | Signed |
|----------|------------|--------|
| Linux x64 | `fusion-linux-x64` | — |
| macOS arm64 | `fusion-darwin-arm64` | ✓ (codesign + notarization) |
| macOS x64 | `fusion-darwin-x64` | ✓ (codesign + notarization) |
| Windows x64 | `fusion-windows-x64.exe` | ✓ (Authenticode) |

## Testing binary builds

Use the **Test Release** workflow (`test-release.yml`) to manually test binary builds without creating a real release:

1. Go to **Actions** → **Test Release** → **Run workflow**
2. The workflow builds all 4 platform binaries, runs smoke tests, and uploads artifacts
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
| `pnpm release:version` | Apply changesets and bump versions (used by CI) |
| `pnpm --filter @gsxdsm/fusion build:exe` | Build binary for current platform |
| `pnpm --filter @gsxdsm/fusion build:exe -- --target <target>` | Cross-compile for a specific platform |
| `pnpm --filter @gsxdsm/fusion build:exe:all` | Build binaries for all platforms |

## Tips

- Every user-facing change should have a changeset — CI will remind you if one is missing
- You can add multiple changesets per PR if you're making changes to multiple packages
- Changeset files are automatically deleted when versions are bumped
- CI verifies binary compilation on every push/PR to catch build regressions early
