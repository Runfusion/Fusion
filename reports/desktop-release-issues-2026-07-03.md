# Fusion Desktop Release Issues — Field Report

**Date:** 2026-07-03  
**Reporter:** Hermes Ouroboros / Automata Intelligentsia  
**Host:** Windows 11 (build 26200)  
**Fusion versions observed:** 0.51.0 (last known good), 0.52.0 (current desktop release with regressions)  
**Test environment:** `C:\Users\drewd\Tools\fusion-latest` (local source checkout), `npm install -g @runfusion/fusion` published package, and the v1.1.0 standalone desktop wrapper.

This document collects the issues we found while trying to run the official Fusion desktop build on Windows, what we attempted, and what we believe the Fusion team needs to address.

---

## Resolution status (PR #1883)

| # | Issue | Status |
|---|-------|--------|
| 1 | `electron` only a devDependency | **Fixed** — `electron` added to `@runfusion/fusion` runtime deps; lockfile synced. |
| 2 | Ancestor-dir walk crashes on unrelated JSON | **Already handled** — the desktop launcher uses `process.cwd()` (CLI) / `$HOME` (Electron main), never an ancestor walk (`desktop.ts:175`, `main.ts` `resolveLocalRuntimeRoot`), and every JSON parse on the shared discovery path is already `try/catch`-guarded, so unrelated JSON no longer throws. |
| 3 | Manage Projects opens Settings | **Fixed** — `handleViewAllProjects` now resets `taskView` to `command-center`. |
| 4 | Windows Terminal "Help" dialogs | **Fixed (real root cause found)** — the trigger was NOT the embedded terminal (already guarded) but the **worktrunk integration**: worktrunk's CLI is named `wt`, which collides with Windows Terminal (`wt.exe`) on PATH, so `wt --version` launched Windows Terminal. Fixed by (a) not auto-probing worktrunk status on Settings/dashboard mount — only when the integration is enabled (user opt-in), and (b) an engine-level guard in `probeWorktrunk` that refuses to exec the Windows Terminal alias. The 1882 frontend terminal-auto-create guard is retained as defense-in-depth. |
| 5 | Packaged build can miss `preload`/assets | **Fixed** — `scripts/build.ts` now verifies `main.js`, `preload.js`, and `client/index.html` exist in both `dist/` and the staged `deploy/dist/` before packaging, failing the build otherwise. (In this repo the preload ships as `dist/preload.js` inside `app.asar`, not `preload.cjs`.) |
| 6 | Desktop port drift / collision | **Already handled** — the embedded runtime binds an ephemeral port (`app.listen(0)`, `desktop.ts:78`), so fixed-port collision is structurally impossible; the CLI passes it via `FUSION_SERVER_PORT` and the desktop reuses it instead of double-binding (Issue 9), and a single-instance lock (`deep-link.ts`) quits a duplicate window. A fixed 9119/8643 would *reintroduce* collisions, so we deliberately did not pin one. |
| 7 | GPU/sandbox instability on Windows | **Fixed** — GPU/sandbox-disabling flags applied on Windows only (`os.platform() === "win32"`); macOS/Linux keep hardware acceleration and the sandbox. |
| 8 | User-data not isolated | **Fixed** — desktop profile relocated under `~/.fusion/desktop-user-data`, with a one-time copy migrating an existing operator's previous profile (window geometry/session) so upgrades don't lose state. |
| 9 | Desktop doesn't reuse a running server | **Fixed** — when `FUSION_SERVER_PORT` is set the desktop attaches to the CLI's dashboard instead of spawning an embedded runtime. |

Recommendation #2 (verify packaged Windows layout before publishing) is now **enforced in CI**: `desktop-windows.yml` asserts the shipped `app.asar` contains `dist/main.js`, `dist/preload.js`, and `dist/client/index.html`, on top of `scripts/build.ts`'s pre-package staging check.

Remaining as future team work (deliberately not attempted here): recommendation #1's full GUI-launch smoke (launch `Fusion.exe` and assert the window is visible/responsive) — reliably asserting a rendered Electron window on a CI runner is flaky, which the project's standing anti-flaky rule forbids adding; and the port/process auditing docs for Issue 6.

---

## Issue 1: `fusion desktop` fails to launch on Windows 0.52.0

### Symptom
Running `fusion desktop` from the published npm package immediately errors out with a dynamic require / Electron binary resolution failure. The CLI cannot find `electron` because the published `@runfusion/fusion` package lists `electron` only as a `devDependency`, not a runtime dependency.

### What we tried
1. Installed `@runfusion/fusion@latest` globally.
2. Ran `fusion desktop --no-auth` from a project directory.
3. Observed that `require('electron')` fails because Electron is not installed alongside the published CLI.
4. Checked `packages/cli/package.json` in the source repo: `electron` is under `devDependencies`.

### Proposed fix
Add `electron` to the `dependencies` (or `optionalDependencies`) of `@runfusion/fusion` so that a global npm install pulls in the Electron binary required by `packages/cli/src/commands/desktop.ts`.

---

## Issue 2: Native desktop build walks ancestor directories and fails on unrelated workspace JSON

### Symptom
When `fusion desktop` does manage to start the native Electron build, the launcher walks up the directory tree looking for a Fusion workspace. It can land on an unrelated ancestor directory (e.g., `C:\Users\drewd\Tools`) and fail because it parses JSON files in sibling or parent workspaces that are not valid Fusion project assets.

### What we tried
1. Ran `fusion desktop` from `C:\Users\drewd\Tools\fusion-latest`.
2. The launcher searched ancestor directories instead of using the current working directory as the project root.
3. It then choked on invalid JSON in assets that were never intended to be loaded as Fusion metadata.

### Proposed fix
- Restrict workspace discovery to the current working directory or a user-selected/project-configured root.
- Treat missing/invalid JSON as non-fatal during workspace discovery; log and continue rather than crashing the launcher.
- Add a CLI flag or config key to pin the project root explicitly.

---

## Issue 3: Manage Projects button opens Settings instead of the project overview

### Symptom
In the dashboard header, clicking **Manage Projects** lands on the **Settings** page instead of the project list/overview.

### Root cause
`handleViewAllProjects` in `packages/dashboard/app/hooks/useProjectActions.ts` resets `viewMode` to `"overview"` and clears the current project, but it leaves `taskView` unchanged. `MainContent` checks `taskView === "settings"` before the `viewMode === "overview"` branch, so any previously selected settings view is rendered instead of `ProjectOverview`.

### What we tried
- Traced the routing through `App.tsx`, `useProjectActions.ts`, `useViewState.ts`, and `MainContent.tsx`.
- Threaded `setTaskView` into `useProjectActions` and reset `taskView` to `"command-center"` when leaving a project.

### Proposed fix
Apply the same fix as PR #1882: make `handleViewAllProjects` reset `taskView` to the overview landing view so the settings branch cannot shadow the overview branch.

---

## Issue 4: Windows Terminal native "Help" version dialogs on dashboard load / Settings

### Symptom
On Windows, opening the dashboard (and especially the Settings page) produces two native Windows message boxes titled **Help**, showing:

```
Windows Terminal
1.24.11321.0
```

### Root cause (corrected)
The initial hypothesis blamed the embedded terminal's PTY auto-create. That path was already fully guarded (`terminal-service.ts` excludes `wt.exe`, ignores `SHELL` on win32, defaults to `cmd.exe`, maps the version-only spawn to an actionable error), so the dialog persisted after the 1882 frontend guard. The **actual** trigger is the **worktrunk integration**: worktrunk's CLI binary is named `wt` (`WORKTRUNK_BINARY_NAME = "wt"`), which is the same executable name as Windows Terminal (`wt.exe`, an App Execution Alias under `%LOCALAPPDATA%\Microsoft\WindowsApps`, on PATH by default on Windows 11). Worktrunk resolution runs `where wt` → finds Windows Terminal → runs `"wt.exe" --version` to probe it → **launches Windows Terminal**, which shows the native "Windows Terminal 1.24.11321.0" version dialog. This fired because the dashboard/Settings UI auto-fetched worktrunk status (`GET /api/worktrunk/status`) on mount, even when worktrunk was not in use.

### Fix
1. **Don't probe worktrunk automatically.** `useWorktrunkInstallStatus` now only auto-fetches status when the worktrunk integration is enabled (user opt-in / explicit request); a plain Settings/dashboard mount no longer probes.
2. **Engine invariant guard.** `probeWorktrunk` refuses to `exec` a resolved `wt` that is the Windows Terminal alias (basename `wt` under `WindowsApps` / a `WindowsTerminal` package dir), returning an actionable error instead of launching it. This covers every resolution surface (cached / override / PATH / install / settings-route).
3. The 1882 frontend terminal-auto-create guard is retained as defense-in-depth.

### Symptom Verification
- **Original symptom:** Opening the dashboard / Settings on Windows pops native "Windows Terminal 1.24.11321.0" Help dialogs.
- **Exact reproduction:** On Windows 11 (Windows Terminal on PATH), worktrunk resolution runs `where wt` → `wt.exe` → `"wt.exe" --version` → GUI dialog; auto-triggered by the Settings worktrunk-status fetch on mount.
- **Assertion it is gone:** `probeWorktrunk` returns `{ ok: false }` for a `WindowsApps\wt.exe` path **without** calling `exec` (`worktrunk-installer.test.ts`); `resolveWorktrunkBinary` never execs `--version` against a Windows Terminal PATH hit; and `useWorktrunkInstallStatus` does not fetch `/api/worktrunk/status` on mount unless enabled (`useWorktrunkInstallStatus.test.ts`).

### Surface Enumeration
Worktrunk resolution surfaces all funnel through `probeWorktrunk`, so the engine guard covers them uniformly: cached resolution, explicit `binaryPath` override, PATH auto-discovery (`worktree-pool.ts`), Fusion-managed install path, the Settings-save enable validation (`register-settings-memory-routes.ts`), and the `GET /worktrunk/status` route (`register-worktrunk-routes.ts`). The frontend auto-fetch (`useWorktrunkInstallStatus`, used by `SettingsModal`) is the only automatic client trigger and is now gated on `enabled`.

---

## Issue 5: `fusion desktop` native build uses the wrong working directory for `preload.cjs` and other Electron assets

### Symptom
The packaged native desktop build can fail to load `preload.cjs` because the packaged app looks under `release/win-unpacked/resources/app.asar.unpacked/electron/`, but that path may be incomplete after `npm run dist`.

### What we tried
- Extracted the published v1.0.0 wrapper source and compared it to the source tree.
- Found that `apps/desktop/electron/preload.cjs` exists in source but is missing in the packaged layout on some installs.
- Confirmed the workaround: copy `preload.cjs` into the missing unpacked location.

### Proposed fix
- Add a packaging verification step that asserts `preload.cjs` is present in the expected unpacked path before publishing.
- Consider bundling the preload script into the main asar so the path is deterministic.
- Document the Windows packaging layout and the required Electron files.

---

## Issue 6: Native desktop build runs on port 9119/8643 but conflicts with dashboard and other instances

### Symptom
On Windows, the dashboard backend can end up on a non-standard port or collide with another running dashboard instance (e.g., 9120, 7380–7385). The packaged desktop also expects gateway 8643 and dashboard 9119 per the docs, but the actual port can drift.

### What we tried
- Used `Get-NetTCPConnection` to map ports to process names because `ps`/`netstat` in MSYS mis-enumerate Electron/pythonw/WSL processes.
- Found that duplicate dashboard processes can occur when system Python and venv Python both try to start on the same port.

### Proposed fix
- Lock down the desktop build to deterministic ports with a port-file lock or named mutex on Windows.
- Show a clear error when another Fusion desktop/dashboard is already running instead of silently binding elsewhere.
- Document the canonical Windows ports and how to audit them.

---

## Issue 7: GPU/sandbox rendering issues on Windows Electron

### Symptom
The native desktop window can be blank, flicker, or fail to render on some Windows GPUs. We observed this both with the wrapper and the native desktop build.

### What we tried
- Added Electron flags to disable GPU and sandbox in the wrapper and native launch path:
  - `--disable-gpu`
  - `--disable-gpu-compositing`
  - `--disable-gpu-sandbox`
  - `--disable-software-rasterizer`
  - `--no-sandbox`
- These flags improved stability in the wrapper.

### Proposed fix
- Expose these flags as the default on Windows, or make them configurable in the dashboard settings.
- Detect GPU process crashes and automatically fall back to software rendering with a toast notification.

---

## Issue 8: Desktop user-data path is not isolated / collides with other Electron apps

### Symptom
Crash dumps, caches, and local storage from the Fusion desktop can end up in a generic Electron user-data directory or collide with other Electron apps using the same defaults.

### What we tried
- Set `app.setPath("userData", "...")` to `~/.fusion/desktop-user-data` and sub-paths for cache/crashes in the wrapper.

### Proposed fix
- Apply the same isolation in the native desktop build so sessions, logs, and crash data live under `~/.fusion/` and are easy to inspect or reset without affecting other Electron apps.

---

## Issue 9: CLI desktop command does not reuse an already-running dashboard server

### Symptom
Running `fusion desktop` while `fusion dashboard` (or the wrapper) is already serving on 4040 starts a second process rather than connecting to the existing one.

### What we tried
- Modified `packages/desktop/src/main.ts` to detect `FUSION_SERVER_PORT` and skip `startLocalRuntimeOnce` when the CLI already started a server.

### Proposed fix
- Add a stable port probe / heartbeat before starting the Electron runtime.
- If a dashboard is already running on the expected port, load that URL instead of spawning another engine.

---

## General recommendations for the Fusion team

1. **Windows CI:** Add a Windows build step that runs `fusion desktop` in a clean VM and asserts the window title is visible and responsive.
2. **Release tests:** Before tagging a desktop release, verify the packaged `release/win-unpacked` layout has all required Electron assets (`preload.cjs`, etc.).
3. **Dependency audit:** Move `electron` out of `devDependencies` in the published CLI package, or document that users must install it separately.
4. **Field test with wrapper users:** The wrapper at `https://github.com/Automata-intelligentsia/fusion-desktop-windows/releases/tag/v1.1.0` is a proven workaround; consider adopting its launch model (CLI server + Electron shell) as an official fallback until the native desktop build is stabilized on Windows.

---

## Related PRs

- `Runfusion/Fusion#1882` — dashboard routing and Windows Terminal popup fix.
- `Automata-intelligentsia/fusion-desktop-windows#v1.1.0` — standalone Windows wrapper that works around the native desktop regressions.
