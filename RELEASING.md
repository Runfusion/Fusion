# Releasing

This project uses [changesets](https://github.com/changesets/changesets) for automated versioning and release management.

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

When changesets are merged to `main`, a GitHub Actions workflow automatically opens (or updates) a **"Version Packages"** pull request. This PR:

- Consumes all pending changeset files
- Bumps package versions according to the changeset declarations
- Generates/updates `CHANGELOG.md` files for affected packages

### 3. Merge the Version PR to release

When you merge the Version Packages PR:

- The workflow detects that all changesets have been consumed
- It creates a git tag `v{version}` based on the `hai` CLI package version
- The tag push triggers the existing release workflow (`.github/workflows/release.yml`)
- The release workflow builds binaries and creates a GitHub Release

## Manual release (fallback)

If you need to release manually, you can still push a version tag directly:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This will trigger the release workflow. Note: the workflow validates that the tag version matches `packages/cli/package.json`, so make sure they're in sync.

## Available scripts

| Script | Description |
|--------|-------------|
| `pnpm changeset` | Add a new changeset |
| `pnpm changeset status` | Check pending changesets |
| `pnpm release:version` | Apply changesets and bump versions (used by CI) |

## Tips

- Every user-facing change should have a changeset — CI will remind you if one is missing
- You can add multiple changesets per PR if you're making changes to multiple packages
- Changeset files are automatically deleted when versions are bumped
