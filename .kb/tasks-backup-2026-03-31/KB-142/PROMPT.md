# Task: KB-142 - Fix CLI build-exe native module packaging

**Created:** 2026-03-30
**Size:** M

## Review Level: 3 (Full)

**Assessment:** This task changes the published `@dustinbyrne/kb` standalone binary build path, runtime bootstrap, and release/test packaging for native `node-pty` assets. The failure is localized to CLI executable builds, but a bad fix can break `--help`, `task list`, dashboard startup, or shipped release artifacts across platforms.
**Score:** 6/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Fix the standalone CLI executable path so `pnpm test` passes the build-exe suites and the Bun-compiled `kb` binary works with `node-pty` native support. Today the compiled binary eagerly pulls in dashboard code from `packages/cli/src/bin.ts`, and dashboard startup eventually hits `packages/dashboard/src/terminal-service.ts`, where `node-pty` tries to load `prebuilds/<platform-arch>/pty.node` from `/$bunfs/root/kb` even though `packages/cli/build.ts` only stages `dist/client/`. The result is that isolated executable smoke tests fail for `--help`, `task list`, and `dashboard`. Restore a correct runtime/package layout so lightweight CLI commands do not require dashboard-native modules up front, dashboard binaries can find the required native sidecars/helpers when needed, and release/test workflows ship the full executable payload.

## Dependencies

- **None**

## Context to Read First

- `AGENTS.md`
- `package.json`
- `packages/cli/package.json`
- `packages/dashboard/package.json`
- `packages/cli/build.ts`
- `packages/cli/tsup.config.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/commands/dashboard.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/terminal-service.ts`
- `packages/cli/src/__tests__/build-exe.test.ts`
- `packages/cli/src/__tests__/build-exe-cross.test.ts`
- `packages/cli/src/__tests__/bundle-output.test.ts`
- `packages/cli/src/__tests__/package-config.test.ts`
- `packages/cli/src/__tests__/ci-workflow.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/test-release.yml`
- `scripts/sign-macos.sh`
- `scripts/sign-windows.ps1`
- `packages/cli/STANDALONE.md`

## File Scope

- `packages/cli/build.ts`
- `packages/cli/package.json`
- `packages/cli/tsup.config.ts`
- `packages/cli/src/bin.ts`
- `packages/cli/src/commands/dashboard.ts`
- `packages/cli/src/runtime/*`
- `packages/cli/src/__tests__/build-exe.test.ts`
- `packages/cli/src/__tests__/build-exe-cross.test.ts`
- `packages/cli/src/__tests__/bundle-output.test.ts`
- `packages/cli/src/__tests__/package-config.test.ts`
- `packages/cli/src/__tests__/ci-workflow.test.ts`
- `packages/dashboard/src/server.ts`
- `packages/dashboard/src/routes.ts`
- `packages/dashboard/src/terminal-service.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/test-release.yml`
- `scripts/sign-macos.sh`
- `scripts/sign-windows.ps1`
- `packages/cli/STANDALONE.md`
- `packages/cli/README.md`
- `README.md`
- `.changeset/*.md`

## Steps

### Step 0: Preflight

- [ ] Required files and paths exist
- [ ] Dependencies satisfied

### Step 1: Stop eager native loading and make standalone runtime resolve node-pty assets correctly

- [ ] Reproduce the current regression with `pnpm --filter @dustinbyrne/kb test -- src/__tests__/build-exe.test.ts src/__tests__/build-exe-cross.test.ts` and confirm the failure mode matches the current `pty.node` resolution error from the Bun binary (`/$bunfs/root/kb`)
- [ ] Update `packages/cli/src/bin.ts` so `--help` and non-dashboard task commands no longer import dashboard/native terminal code at process startup; dashboard code should load only when the `dashboard` command path is actually selected
- [ ] Add runtime support in the CLI build path so the standalone output includes the `node-pty` native payload required by dashboard binaries on supported targets and the runtime resolves those real filesystem sidecars/helpers instead of relying on Bun-embedded paths
- [ ] Adjust `packages/dashboard/src/server.ts`, `packages/dashboard/src/routes.ts`, and/or `packages/dashboard/src/terminal-service.ts` only as needed so terminal initialization happens after the standalone runtime is prepared, without removing PTY terminal support
- [ ] Add or update regression tests that prove isolated executable `--help`, `task list`, and `dashboard --no-open` flows succeed with the new runtime behavior, including at least one automated standalone-binary test that starts the copied dashboard payload, calls `POST /api/terminal/sessions`, and asserts a real terminal session can be created without native-module errors, then rerun `pnpm --filter @dustinbyrne/kb test -- src/__tests__/build-exe.test.ts src/__tests__/build-exe-cross.test.ts`

**Artifacts:**
- `packages/cli/build.ts` (modified)
- `packages/cli/src/bin.ts` (modified)
- `packages/cli/src/commands/dashboard.ts` (modified, if needed)
- `packages/cli/src/runtime/*` (new, if needed)
- `packages/dashboard/src/server.ts` (modified, if needed)
- `packages/dashboard/src/routes.ts` (modified, if needed)
- `packages/dashboard/src/terminal-service.ts` (modified)
- `packages/cli/src/__tests__/build-exe.test.ts` (modified)
- `packages/cli/src/__tests__/build-exe-cross.test.ts` (modified)

### Step 2: Align package metadata, bundle assertions, and release workflows with the executable payload

- [ ] Update package/build metadata so the published npm package still excludes Bun-produced binaries while the standalone executable output and any co-located native sidecars remain intentionally staged for build/release workflows
- [ ] Extend `packages/cli/src/__tests__/bundle-output.test.ts`, `package-config.test.ts`, and `ci-workflow.test.ts` to assert the new layout and protect against regressions in bundle contents, publish globs, and workflow packaging behavior
- [ ] If the executable is no longer a single-file artifact, update `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `.github/workflows/test-release.yml` so verification, uploaded artifacts, and smoke tests all use the same release-style payload root (binary + `client/` + required native/runtime sidecars for each target)
- [ ] If the new payload introduces additional executable or notarization-sensitive files, update `scripts/sign-macos.sh` and `scripts/sign-windows.ps1` so signing/verification still applies to the shipped standalone payload, not just the top-level binary file
- [ ] Ensure isolated-dir test helpers copy the full executable payload rather than only `client/`, so smoke tests exercise the same on-disk layout the release workflows generate
- [ ] Run `pnpm --filter @dustinbyrne/kb test -- src/__tests__/bundle-output.test.ts src/__tests__/package-config.test.ts src/__tests__/ci-workflow.test.ts`

**Artifacts:**
- `packages/cli/package.json` (modified)
- `packages/cli/tsup.config.ts` (modified, if needed)
- `packages/cli/src/__tests__/bundle-output.test.ts` (modified)
- `packages/cli/src/__tests__/package-config.test.ts` (modified)
- `packages/cli/src/__tests__/ci-workflow.test.ts` (modified)
- `.github/workflows/ci.yml` (modified, if needed)
- `.github/workflows/release.yml` (modified, if needed)
- `.github/workflows/test-release.yml` (modified, if needed)
- `scripts/sign-macos.sh` (modified, if needed)
- `scripts/sign-windows.ps1` (modified, if needed)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm --filter @dustinbyrne/kb test -- src/__tests__/build-exe.test.ts src/__tests__/build-exe-cross.test.ts src/__tests__/bundle-output.test.ts src/__tests__/package-config.test.ts src/__tests__/ci-workflow.test.ts`
- [ ] Run `pnpm --filter @dustinbyrne/kb build:exe` and smoke-test the host-platform standalone output from its staged directory layout, including real terminal-session creation through the dashboard API
- [ ] Run full test suite with `pnpm test`
- [ ] Fix all failures
- [ ] Build passes with `pnpm build`

### Step 4: Documentation & Delivery

- [ ] Add a patch changeset for `@dustinbyrne/kb` describing the standalone executable native-module packaging fix
- [ ] Update standalone CLI documentation to explain the executable payload/runtime expectations introduced by the fix, including any required co-located support files for standalone binaries
- [ ] Update user-facing CLI docs if the release artifact layout or build instructions changed
- [ ] Out-of-scope findings created as new tasks via `task_create` tool

## Documentation Requirements

**Must Update:**
- `.changeset/*.md` — patch changeset for the published standalone CLI packaging/runtime fix
- `packages/cli/STANDALONE.md` — document how standalone binaries are built, what files must stay together on disk, and any platform/native-module caveats

**Check If Affected:**
- `packages/cli/README.md` — update if standalone binary usage or distribution wording changed
- `README.md` — update if top-level install/build/release documentation now misstates the standalone executable layout
- `.github/workflows/ci.yml` — update if CI must verify a multi-file standalone payload instead of only the main binary
- `scripts/sign-macos.sh` — update if macOS release payload signing/notarization must include additional runtime files
- `scripts/sign-windows.ps1` — update if Windows release payload signing/verification must include additional runtime files

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-142): complete Step N — description`
- **Bug fixes:** `fix(KB-142): description`
- **Tests:** `test(KB-142): description`

## Do NOT

- Expand task scope beyond standalone CLI executable loading, native asset packaging, the tests that guard it, and the docs/workflows needed to ship it
- Remove, stub, or permanently disable dashboard terminal support just to make the build-exe tests pass
- Hardcode machine-specific pnpm store, temp, or absolute native module paths into runtime resolution
- Weaken the isolated executable smoke tests so they stop covering `--help`, `task list`, or dashboard startup from a copied release-style directory
- Publish Bun-generated binaries in the npm tarball
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
