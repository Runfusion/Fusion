# Beta + Stable Release Tracks Plan

Date: 2026-07-19
Status: implemented (branch `feature/beta-stable-release-tracks-2`; Phases 1–3 landed, `release` branch bootstrap pending first stable promotion)

## Goal

Ship `@runfusion/fusion` on two tracks users can switch between:

- **beta** — cut from `main`, published to the npm `beta` dist-tag, tagged `vX.Y.Z-beta.N`, marked *prerelease* on GitHub.
- **stable** — cut from a long-lived `release` branch, published to `latest`, tagged `vX.Y.Z`, marked *latest* on GitHub, Homebrew tap bumped.

Users pick a channel via a new `updateChannel` setting consumed by all three update surfaces (CLI `fn update`, dashboard update check, desktop electron-updater).

## Current state (surveyed 2026-07-19)

- Everything publishes to `latest`: `scripts/release.mjs:719-720` (`pnpm -r publish --access public --no-git-checks`, no `--tag`), `version.yml:45`, and `release.mjs:756` hardcodes `gh release create … --latest`.
- `release.yml` (binary workflow, tag-push triggered) never sets `prerelease:` on `softprops/action-gh-release`.
- Changesets: single `fixed` group keeps all packages lockstep (currently 0.72.0); **pre-mode is never used** (no `.changeset/pre.json`).
- Update surfaces all hardcode `dist-tags.latest`:
  - CLI: `packages/cli/src/commands/update.ts` (`fetchLatestVersion`, installs `@runfusion/fusion@latest`), cache in `packages/cli/src/update-cache.ts`, startup banner in `commands/dashboard.ts`.
  - Dashboard: `packages/dashboard/src/update-check.ts` — note `isRemoteNewer` compares only major.minor.patch and **ignores prerelease identifiers**.
  - Desktop: `packages/desktop/src/native.ts` `setupAutoUpdater()` with no `channel`/`allowPrerelease`; feed in `packages/desktop/deploy/electron-builder.yml`.
- No `releaseChannel`/`updateChannel` setting exists (`packages/core/src/settings-schema.ts` has only `updateCheckEnabled`, `updateCheckFrequency`).

## Design

### Branch & version model

- `main` — development + beta releases. Lives in changesets **pre-mode** (`.changeset/pre.json`, tag `beta`) whenever there is unreleased work; beta releases version to `X.Y.Z-beta.N`.
- `release` — new long-lived branch, stable releases only. Created once from current `main`.

Flows:

1. **Beta release (from `main`)**: `pnpm release --channel beta`. Script enters pre-mode if not already in it (`changeset pre enter beta`), runs `changeset version` (→ `0.73.0-beta.0`, `-beta.1`, …), publishes with `--tag beta`, tags `v0.73.0-beta.N`, creates a GitHub **prerelease**. No Homebrew bump, no tweet distill.
2. **Promotion to stable**: merge/fast-forward `release` to the chosen beta's commit on `main`, then on `release`: `pnpm release` (stable channel). Script runs `changeset pre exit`, `changeset version` (→ clean `0.73.0` with the aggregated changelog changesets accumulated across the betas), publishes to `latest`, tags `v0.73.0`, GitHub release `--latest`, bumps the Homebrew tap. Finally **back-merge `release` → `main`** so main picks up the consumed changesets, changelogs, version bump, and the pre.json deletion (next beta re-enters pre-mode automatically).
3. **Hotfix**: commit directly on `release` (or branch off it in a worktree per project rules), add a changeset, run a stable release there, cherry-pick the fix back to `main`.

Changesets pre-mode is exactly built for this: beta versions consume pending changesets but record them in `pre.json`, and the final `pre exit` + `version` produces one correctly-aggregated stable version and changelog. The `fixed` group keeps all `@fusion/*` packages lockstep as today.

### npm dist-tags

- Stable: `--tag latest` (explicit, both packages including the `runfusion.ai` alias).
- Beta: `--tag beta`. Publishing a beta must never move `latest`.
- Promotion publishes a fresh stable version; no `npm dist-tag add` gymnastics needed.

### GitHub releases & binary workflow

- `release.mjs`: `gh release create` gets `--prerelease` for beta, `--latest` for stable.
- `.github/workflows/release.yml` github-release job: set `prerelease: ${{ contains(github.ref_name, '-beta') }}` on `softprops/action-gh-release` (tag drives it, so tag-push-triggered binary builds do the right thing automatically).
- Desktop electron-builder: for beta builds pass `channel: beta` in the publish config so electron-updater manifests split into `beta*.yml` vs `latest*.yml`; electron-updater then selects by channel client-side.

## Implementation phases

### Phase 1 — publish side (`scripts/release.mjs`, workflows)

1. Add `--channel beta|stable` (default `stable`) to `release.mjs`:
   - Preflight: beta requires branch `main`; stable requires branch `release` (keep the clean-tree / not-behind / pending-changeset checks; for stable in pre-mode, "pending" means pre.json has recorded changesets).
   - Beta path: auto `changeset pre enter beta` when `.changeset/pre.json` absent → `pnpm release:version` → publish `pnpm -r publish --access public --no-git-checks --tag beta` → commit/tag `vX.Y.Z-beta.N` → `gh release create --prerelease` → **skip** `bumpHomebrewTap` and the tweet draft.
   - Stable path: `changeset pre exit` if pre.json present → version → publish `--tag latest` → tag/GH release `--latest` → Homebrew bump → back-merge `release` into `main` (or print the exact command if the merge needs conflict resolution).
   - `--dry-run` must work for both channels.
2. `release.yml`: prerelease flag on the GitHub release step keyed off the tag name; thread `channel: beta` into the electron-builder desktop legs for beta tags.
3. `version.yml` (CI npm publish, dispatch-only): add a `channel` input mirroring the same logic, or explicitly document it as stable-only until needed.
4. Create the `release` branch from current `main`; protect it like `main`.

### Phase 2 — `updateChannel` setting + channel-aware update surfaces

1. Core: add `updateChannel?: "stable" | "beta"` (default `"stable"`) to global settings (`packages/core/src/types.ts`, `settings-schema.ts`). Expose in the dashboard SettingsModal next to the existing update-check settings, and via `fn update --channel <stable|beta>` (persists the choice).
2. Shared resolution rule (implement once, reuse): the target version for channel *C* is
   - stable: `dist-tags.latest`
   - beta: semver-max(`dist-tags.latest`, `dist-tags.beta`) — so beta users are offered a newly promoted stable when it overtakes their beta.
3. CLI `packages/cli/src/commands/update.ts`: fetch both dist-tags, resolve per channel, and install the **explicit version** (`npm i -g @runfusion/fusion@<version>`) instead of `@latest`. Include the channel in `--check`/`--json` output and the startup banner (`commands/dashboard.ts`), and store it in the `update-check.json` cache so a channel switch invalidates the cache.
4. Dashboard `packages/dashboard/src/update-check.ts`: same resolution; **replace `isRemoteNewer` with a full semver comparison including prerelease ordering** (today `0.73.0-beta.2` vs `-beta.3` compare equal, and `0.73.0-beta.0` vs `0.73.0` would too). Same fix applies anywhere `parseSemver` (`packages/core/src/app-version.ts`) feeds an ordering decision.
5. Desktop `packages/desktop/src/native.ts`: when channel is beta, set `autoUpdater.channel = "beta"` and `autoUpdater.allowPrerelease = true` before `checkForUpdates()`.
6. Channel-switch semantics (document in `docs/settings-reference.md` and the CLI help):
   - stable → beta: next check offers the current beta immediately.
   - beta → stable: no downgrade offered; user stays on their beta until the next stable overtakes it. `fn update --channel stable --force` installs the current stable explicitly as an opt-in downgrade.

### Phase 3 — polish / optional

- Homebrew: tap stays stable-only. If beta demand appears, add a separate `fusion-beta` formula rather than making `fusion.rb` channel-aware.
- Dashboard banner copy distinguishes "Beta update available" vs stable.
- Docs: `docs/cli-reference.md` (`fn update --channel`), `docs/settings-reference.md` (`updateChannel`), `docs/contributing.md` (release runbook: beta cadence on main, promotion checklist, hotfix flow).

## Testing

- `release.mjs`: extend the existing dry-run coverage for both channels (branch preflight, dist-tag selection, prerelease flag, Homebrew skip, pre-mode enter/exit); no real publishes in tests.
- Unit tests for the channel resolution rule (stable/beta × ahead/behind/equal, prerelease ordering) in both `packages/cli` and `packages/dashboard` — file-scoped vitest per the verification standing rule.
- Full semver-compare tests for the `isRemoteNewer` replacement, including `X.Y.Z-beta.N < X.Y.Z`.
- First real beta: publish `0.73.0-beta.0`, verify `npm dist-tag ls @runfusion/fusion` shows `latest` unchanged, GitHub release shows *Pre-release*, `fn update --check` on a stable-channel install stays quiet, on beta channel offers it.

## Risks / gotchas

- **`latest` pollution is the one unrecoverable-embarrassing failure** — the publish command must always pass an explicit `--tag`; never rely on npm's default.
- Changesets pre-mode + the custom `sync-workspace-version.mjs` / changelog-distill pipeline haven't been exercised together; validate with `--dry-run` and a throwaway `0.73.0-beta.0` before trusting it.
- The prerelease-blind comparators (`isRemoteNewer`, `parseSemver` consumers) will misbehave the moment a `-beta.N` version exists anywhere — Phase 2 item 4 should land **before or with** the first published beta.
- Back-merge `release` → `main` can conflict on `CHANGELOG.md`/`package.json` if main moved during promotion; the script should fail soft with instructions rather than force it.
- Releases remain operator-only (`pnpm release`), per the standing rule — nothing here changes that; the interactive "authorized" gate stays for both channels.
