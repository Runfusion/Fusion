# @fusion/desktop

Electron desktop shell for Fusion.

This package provides a native Electron wrapper around the existing Fusion dashboard web UI. The desktop shell presents native desktop affordances including a system tray and application menu, with an embedded renderer for production deployments.

## Running the Desktop Shell

### Hot-reload development workflow

Run a single command from the workspace root:

```bash
pnpm --filter @fusion/desktop dev
```

This command now orchestrates the full desktop dev loop:

1. Bundles Electron `main.ts` and `preload.ts` to `packages/desktop/dist`
2. Starts the dashboard Vite renderer dev server (`@fusion/dashboard dev:serve`)
3. Waits for renderer readiness
4. Launches Electron with `--dev` and live renderer reload

By default it uses `http://localhost:5173`. Override with `FUSION_DASHBOARD_URL`.

### Production-style desktop launch (from CLI)

<!--
FNXC:DesktopCLI 2026-06-21-12:00:
Desktop CLI launch shares the local dashboard runtime path, so the docs must state that `fn desktop` starts the embedded dashboard server and the local AI engine by default.
`--paused` keeps the engine process running but disables automation, and desktop must not imply a dashboard-only no-engine mode exists.
-->

```bash
fn desktop
```

`fn desktop` builds desktop artifacts, starts an embedded dashboard server plus the local AI engine on an ephemeral port, and launches Electron with embedded renderer assets.

Useful flags:

- `fn desktop --dev` — use dev renderer URL (`FUSION_DASHBOARD_URL` or `http://localhost:5173`)
- `fn desktop --paused` — start with the AI engine paused (automation disabled)

## Renderer Architecture

The desktop uses a dual-mode renderer strategy:

### Production Mode (default)
- Loads embedded dashboard assets from `dist/client/` (bundled at build time)
- Uses `window.loadFile()` to load `dist/client/index.html`
- Renderer connects to the embedded API server via IPC (`getServerPort()`)

### Development Mode (`--dev` or `NODE_ENV=development`)
- Loads renderer from `FUSION_DASHBOARD_URL` (defaults to `http://localhost:5173`)
- Uses `window.loadURL()` for live reload support
- Renderer connects to the dev API server

### Renderer Resolution (`src/renderer.ts`)

```typescript
isDevelopmentMode()  // Checks NODE_ENV or --dev flag
isUrlRenderer()     // true in dev mode, false in production
getRendererUrl()     // Returns URL or file:// path
getRendererFilePath() // Returns absolute file path for loadFile()
```

## First-run Shell Onboarding (Desktop)

Desktop boots through a shell-owned mode chooser before mounting the dashboard app when the user has not completed mode selection yet.

- **First run choice:** users choose **Local Fusion (bundled runtime)** or **Remote connection path**.
- **Mode contract:** `desktopMode` is `"local" | "remote" | null` and `hasCompletedModeSelection` determines whether the renderer treats startup as first-run. IPC also exposes a renderer-safe `{ isFirstRun, desktopMode }` shape via `shell:getDesktopModeState`.
- **Desktop mode restore:** launch mode is stored in `app.getPath("userData")/desktop-launch-mode.json` as `{ "mode": "choose" | "local" | "remote" }` and reused on relaunch.
- **Restore rules:** `choose` keeps chooser-first startup behavior, `local` attempts to start the embedded local runtime on launch, and `remote` skips embedded runtime startup.
- **Failure fallback:** if remembered `local` restore fails, the shell stops partial runtime state, falls back to `choose`, and persists that fallback to avoid broken relaunch loops.
- **Remote profiles:** multiple saved profiles are supported (`name`, `serverUrl`, optional `authToken`) and can be created/edited/switched/deleted from the dashboard connection manager.
- **Delete fallback:** if the active profile is deleted, desktop shell settings automatically select the first remaining profile; deleting the final profile leaves a valid empty payload (`activeProfileId: null`, `profiles: []`).
- **Storage boundary:** shell connection state is stored only in desktop-local app data at `app.getPath("userData")/shell-connections.json` and is not written to `.fusion/config.json` or dashboard project storage keys.

### Production vs dev bootstrap behavior

- **Production (`fn desktop`)**: renderer mounts `DesktopShellBootstrap`, which resolves shell mode via preload/IPC and either renders the chooser or mounts the dashboard shell. In remote mode, the dashboard shell opens the native connection onboarding/manager flow instead of the local runtime path.
- **Dev (`pnpm --filter @fusion/desktop dev`)**: same mode bootstrap flow runs; only the renderer source (Vite URL vs bundled file) changes.

## IPC Channel Reference

`src/ipc.ts` registers renderer ↔ main process bridges used by `window.electronAPI` (desktop renderer transport/window controls) and `window.fusionShell` (shared shell connection contract for dashboard code).

### Renderer → Main (`ipcRenderer.invoke`)

| Channel | Direction | Parameters | Returns |
|---|---|---|---|
| `window:minimize` | renderer → main | none | `Promise<void>` |
| `window:maximize` | renderer → main | none | `Promise<boolean>` (new maximized state) |
| `window:close` | renderer → main | none | `Promise<void>` |
| `window:isMaximized` | renderer → main | none | `Promise<boolean>` |
| `app:getSystemInfo` | renderer → main | none | `Promise<{ platform; arch; electronVersion; nodeVersion; appVersion; }>` |
| `app:checkForUpdates` | renderer → main | none | `Promise<{ status: "checking" } \| { status: "unavailable"; reason: string } \| { status: "error"; error: string }>` |
| `app:getServerPort` | renderer → main | none | `Promise<number \| undefined>` (external CLI port when present; otherwise embedded local runtime port when running) |
| `desktopRuntime:getStatus` | renderer → main | none | `Promise<DesktopRuntimeStatus>` |
| `desktopRuntime:startLocal` | renderer → main | none | `Promise<DesktopRuntimeStatus>` |
| `desktopRuntime:stopLocal` | renderer → main | none | `Promise<DesktopRuntimeStatus>` |
| `desktopLaunchMode:getMode` | renderer → main | none | `Promise<"choose" \| "local" \| "remote">` |
| `desktopLaunchMode:setMode` | renderer → main | `mode: "choose" \| "local" \| "remote"` | `Promise<"choose" \| "local" \| "remote">` |
| `tray:updateStatus` | renderer → main | `status: "running" \| "paused" \| "stopped"` | `Promise<void>` |
| `native:showExportDialog` | renderer → main | none | `Promise<string \| null>` |
| `native:showImportDialog` | renderer → main | none | `Promise<string \| null>` |

### Main → Renderer Events (`ipcRenderer.on`)

| Channel | Direction | Payload |
|---|---|---|
| `deep-link` | main → renderer | `DeepLinkResult` (`{ type, id, raw }`) |
| `update-available` | main → renderer | update info object (includes `version`) |
| `update-downloaded` | main → renderer | no payload is currently forwarded by preload |
| `update-not-available` | main → renderer | update info object (typically includes current `version`) |
| `update-error` | main → renderer | `{ message: string }` |

## Local Bundled Runtime Lifecycle

Desktop local mode uses an in-process runtime manager (`src/local-runtime.ts`) that mirrors the CLI desktop server pattern:

- creates `TaskStore`, calls `init()` and `watch()`
- creates the dashboard server with `createServer(store)`
- listens on an ephemeral port (`0`, never `4040`)
- reports runtime status as:
  - `source`: `"embedded-local" | "external-cli" | "none"`
  - `state`: `"stopped" | "starting" | "running" | "error"`
  - optional `port`, `baseUrl`, and `error`
- keeps shutdown idempotent and exact-once for embedded server close and store close

### Runtime source rules

- **external-cli**: when `FUSION_SERVER_PORT` is provided (for example by `fn desktop`), Electron treats the server as CLI-owned and does **not** start an embedded server. `desktopRuntime:stopLocal` is a no-op in this state and never kills the CLI-owned server.
- **embedded-local**: when started inside Electron via runtime IPC or startup env activation.
- **none**: no active runtime.

### Activation rules

- Desktop does **not** auto-start embedded local runtime by default.
- Embedded local runtime starts at launch only when `FUSION_DESKTOP_MODE=local` is set.
- Future onboarding/connection flows can start/stop embedded local runtime explicitly over IPC.

## Main Process Lifecycle

`src/main.ts` orchestrates module startup in this order:

1. `loadWindowState()`
2. `loadDesktopLaunchMode()`
3. Restore launch mode behavior (`local` attempts embedded runtime start; `remote`/`choose` skip)
4. `createMainWindow(state)`
5. `buildAppMenu({ mainWindow, appName: "Fusion" })`
6. `setupTray(mainWindow, tray)`
7. `registerIpcHandlers(mainWindow, tray)`
8. `registerDeepLinkProtocol()`
9. `setupDeepLinkHandler(mainWindow)`
10. `setupAutoUpdater(mainWindow)`
11. `startUpdateCheckInterval(mainWindow)` (4-hour periodic background checks)
12. `mainWindow.maximize()` when restored state was maximized

### Window state and close-to-tray behavior

- Startup restores width/height from persisted state (fallback: `DEFAULT_WINDOW_STATE`).
- Restored position (`x`, `y`) is validated against `screen.getAllDisplays()` work areas. If the restored window rectangle has less than `64px × 64px` overlap with every display, `x`/`y` are dropped and the OS picks a visible default location while preserving width/height.
- After `loadURL`/`loadFile`, the window is explicitly `show()` + `focus()` on `ready-to-show`, with a 2-second fallback timer that also `show()`/`focus()`es if `ready-to-show` never fires.
- On window close:
  - state is saved via `saveWindowState(mainWindow)`
  - if app is **not quitting**, close is prevented and the window hides to tray
  - if app **is quitting**, close proceeds normally

### Quit cleanup

- `before-quit` sets `app.isQuitting = true`
- Periodic updater interval is disposed
- Tray instance is destroyed (`tray.destroy()`)
- `mainWindow` is nulled on `closed` for clean re-creation on macOS `activate`

## Preload APIs (`window.electronAPI` and `window.fusionShell`)

`src/preload.ts` exposes safe, context-isolated bridges:

- `window.electronAPI`
  - Window control: `minimize()`, `maximize()`, `close()`, `isMaximized()`
  - App/system: `getSystemInfo()`, `checkForUpdates()`, `getServerPort()`
  - Desktop runtime: `getDesktopRuntimeStatus()`, `startDesktopLocalRuntime()`, `stopDesktopLocalRuntime()`
  - Desktop launch mode: `getDesktopLaunchMode()`, `setDesktopLaunchMode(mode)`
  - Native shell management: `openConnectionManager()` (invokes `shell:openConnectionManager`)
  - Tray: `updateTrayStatus(status)`
  - Native dialogs: `showExportDialog()`, `showImportDialog()`
  - Event subscriptions (return unsubscribe functions):
    - `onDeepLink(callback)`
    - `onUpdateAvailable(callback)`
    - `onUpdateDownloaded(callback)`
    - `onUpdateNotAvailable(callback)`
    - `onUpdateError(callback)`
- `window.fusionShell`
  - `getState()`, `listProfiles()`, `saveProfile()`, `deleteProfile()`
  - `setActiveProfile()`, `setDesktopMode()`
  - `startQrScan()`, `openConnectionManager()`, `subscribe(listener)`
  - Together these cover create/delete/switch operations for shell-owned remote profiles without writing to project/global Fusion settings
- `window.fusionAPI` remains as a backward-compatible alias of `window.electronAPI`.

All preload typings are declared in `src/types.d.ts`.

### Regression coverage locked by tests

Desktop tests under `src/__tests__/` now explicitly lock:
- first-run mode projection and last-used mode restore (`choose`/`local`/`remote`)
- local runtime startup only when local mode is active (and no unexpected startup in remote mode)
- remote mode handoff persistence across relaunch behavior
- preload `fusionShell` bridge channel wiring (`shell:getState`, profile CRUD/switching, mode state, QR, and connection-manager open)

## Module Integration Overview

```text
renderer (window.fusionAPI)
        │
        ▼
   preload.ts (contextBridge)
        │
        ▼
     ipc.ts handlers ───────────► native.ts (dialogs, updater, window state)
        │
        ├────────────────────────► tray.ts (status + tray menu wiring)
        │
        └────────────────────────► main.ts lifecycle orchestration
                                      ├─ menu.ts (application menu)
                                      └─ deep-link.ts (fusion:// protocol + routing)
```

## System Tray

- Left-clicking the tray icon toggles the main window visibility.
- Right-click context menu includes:
  - **Show/Hide Window** (contextual based on visibility)
  - **Pause/Resume Engine** (status toggle placeholder; IPC wiring lands in FN-1076)
  - **Quit Fusion**
- Tray tooltip reflects engine status:
  - `Fusion — Running`
  - `Fusion — Paused`
  - `Fusion — Stopped`
- Tray icon is generated from the Fusion four-dot logo.

## Application Menu

The desktop shell installs a native menu with standard shortcuts.

- **macOS:** App, Edit, View, Window, and Help menus (App menu includes **Check for Updates…**).
- **Windows/Linux:** Edit, View, Window, and Help (Help includes **Check for Updates…**).
- Keyboard shortcuts use Electron `CmdOrCtrl` accelerators for cross-platform behavior.
- View menu includes reload, force reload, dev tools toggle, and zoom controls.

## Native Integrations

`src/native.ts` provides desktop-native utilities used by the Electron main process:

- **Settings file dialogs**
  - `showExportSettingsDialog(parentWindow?)` opens a save dialog for JSON exports using a default filename like `fusion-settings-YYYY-MM-DD-HHmmss.json`.
  - `showImportSettingsDialog(parentWindow?)` opens a single-file JSON picker.
- **Desktop notifications**
  - `showDesktopNotification(title, body, options?)` wraps Electron `Notification` with support checks and optional click callback wiring.
- **Auto-updater integration**
  - `setupAutoUpdater(mainWindow?)` is idempotent, binds updater listeners once, and runs the initial check only once.
  - `triggerUpdateCheck(mainWindow?)` performs on-demand checks (manual menu/IPC trigger) and returns `checking`/`unavailable`/`error` status.
  - `startUpdateCheckInterval(mainWindow, intervalMs?)` schedules periodic background checks (default every 4 hours) and returns a disposer for quit cleanup.
  - Events forwarded to renderer include `update-available`, `update-downloaded`, `update-not-available`, and `update-error`.
  - Auto-update feed metadata is published as GitHub Release assets by `.github/workflows/release.yml` (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) and is what updater checks resolve against.
  - Failures are logged and treated as non-fatal (important for unsigned/local dev builds, which typically surface `update-not-available` or the guarded error path).
- **Window state persistence**
  - `loadWindowState()` reads `window-state.json` from `app.getPath("userData")`.
  - `saveWindowState(mainWindow)` writes bounds/maximized state atomically (`.tmp` + rename).
  - `DEFAULT_WINDOW_STATE` is the fallback (`1280x900`, not maximized).
- **Desktop launch-mode persistence**
  - `loadDesktopLaunchMode()` reads `desktop-launch-mode.json` and returns `"choose" | "local" | "remote"` (invalid/missing files fall back to `"choose"`).
  - `saveDesktopLaunchMode(mode)` writes the mode atomically (`.tmp` + rename).

## Deep Linking

`src/deep-link.ts` implements `fusion://` protocol support.

### Supported URL patterns

- `fusion://task/FN-123` → task deep link
- `fusion://project/my-app` → project deep link
- `fusion://task/FN-123/extra` → extra segments are ignored
- `fusion://project/my%20app` → ID is URL-decoded

Invalid or unsupported URLs (wrong scheme, missing host, unknown host) are ignored.

### Single-instance behavior and platform differences

- `setupDeepLinkHandler(mainWindow)` owns `app.requestSingleInstanceLock()`.
- If no lock is granted, the app quits to avoid duplicate instances.
- **macOS:** listens to `open-url` events.
- **Windows/Linux:** listens to `second-instance` args and extracts `fusion://` URLs.
- Valid parsed deep links are forwarded to the renderer as `mainWindow.webContents.send("deep-link", result)`.

## Cross-Task API Contract (FN-1075 → FN-1076)

FN-1076 depends on these exact exports and names.

### `src/native.ts`

| Export | Type |
|---|---|
| `showExportSettingsDialog` | `(parentWindow?) => Promise<string \| null>` |
| `showImportSettingsDialog` | `(parentWindow?) => Promise<string \| null>` |
| `showDesktopNotification` | `(title, body, options?) => void` |
| `setupAutoUpdater` | `(mainWindow?) => void` |
| `triggerUpdateCheck` | `(mainWindow?) => Promise<{ status: "checking" } \| { status: "unavailable"; reason: string } \| { status: "error"; error: string }>` |
| `startUpdateCheckInterval` | `(mainWindow, intervalMs?) => () => void` |
| `loadWindowState` | `() => Promise<WindowState \| null>` |
| `saveWindowState` | `(mainWindow) => void` |
| `loadDesktopLaunchMode` | `() => Promise<"choose" \| "local" \| "remote">` |
| `saveDesktopLaunchMode` | `(mode) => Promise<void>` |
| `DEFAULT_WINDOW_STATE` | `WindowState` |
| `WindowState` | `interface` |

### `src/deep-link.ts`

| Export | Type |
|---|---|
| `registerDeepLinkProtocol` | `() => void` |
| `parseDeepLink` | `(url: string) => DeepLinkResult \| null` |
| `handleDeepLink` | `(mainWindow, url: string) => void` |
| `setupDeepLinkHandler` | `(mainWindow) => void` |
| `DeepLinkResult` | `interface` |

## Tray Icons

Tray icons are generated from `packages/dashboard/app/public/logo.svg`.

- Script: `pnpm --filter @fusion/desktop generate:icons`
- Package-local equivalent (from `packages/desktop`): `pnpm generate:icons`
- Generated outputs are committed under `src/icons/`:
  - `tray-16.png`
  - `tray-32.png`
  - `tray-48.png`

## Scripts

- `pnpm --filter @fusion/desktop dev` — hot-reload workflow (main/preload bundle + dashboard Vite dev server + Electron)
- `pnpm --filter @fusion/desktop build` — production desktop build (dashboard client build + main/preload bundle + asset copy)
- `pnpm --filter @fusion/desktop test` — run Vitest suite
- `pnpm --filter @fusion/desktop typecheck` — run TypeScript checks without emitting files
- `pnpm --filter @fusion/desktop generate:icons` — regenerate tray icon PNG assets from the dashboard logo SVG
- `pnpm --filter @fusion/desktop pack` — generate unpacked artifacts via electron-builder (`--dir`)
- `pnpm --filter @fusion/desktop dist` — generate installable desktop artifacts via electron-builder
- `pnpm --filter @fusion/desktop dist:win` — generate Windows installable artifacts (`--win`)
- `pnpm --filter @fusion/desktop dist:mac` — generate macOS installable artifacts (`--mac`)
- `pnpm --filter @fusion/desktop dist:linux` — generate Linux installable artifacts (`--linux`)
- `pnpm dist:desktop:win` — workspace alias to build desktop assets then run Windows packaging

## Packaging

Desktop packaging is configured in `electron-builder.yml`.

- Output directory: `packages/desktop/dist-electron`
- Targets: macOS (`dmg`, `zip`), Windows (`nsis`, `portable`), Linux (`AppImage`, `deb`, `tar.gz`)
- Windows artifacts: `Fusion-<version>-win-x64.exe` and `Fusion-<version>-win-arm64.exe` (both NSIS + portable variants) in `packages/desktop/dist-electron/`
- Binary GitHub Release workflow (`.github/workflows/release.yml`) now attaches desktop artifacts for all supported platforms:
  - Electron-updater feed files are also published per platform: `latest.yml` (Windows), `latest-mac.yml` (macOS), and `latest-linux.yml` (Linux). `setupAutoUpdater` / `triggerUpdateCheck` resolve these feeds from the GitHub Release channel.
  - Windows: x64 + arm64 outputs (NSIS + portable), matching `.exe.sha256` sidecars, and `.blockmap` files.
  - macOS: `Fusion-<version>-mac-arm64.dmg`, `Fusion-<version>-mac-x64.dmg`, matching `.zip` variants, `.sha256` sidecars, and `.blockmap` files.
  - Linux: `Fusion-<version>-linux-x64.AppImage` and `Fusion-<version>-linux-arm64.AppImage` with matching `.sha256` sidecars, plus best-effort `.deb` and `.tar.gz` outputs per arch (`Fusion-<version>-linux-x64.{deb,tar.gz}` / `Fusion-<version>-linux-arm64.{deb,tar.gz}`) and sidecars when available on the runner image.
- Tag-less release rehearsal workflow (`.github/workflows/test-release.yml`) mirrors that artifact collection path without publishing a real GitHub Release.
- Linux ARM64 artifacts are cross-built from the `ubuntu-latest` x64 runner by passing `electron-builder --linux --x64 --arm64`; running/validating arm64 installers still requires an arm64 Linux device or emulator.
- Linux desktop artifacts can include detached GPG signature sidecars (`*.AppImage.asc`, `*.deb.asc`, `*.tar.gz.asc`) when Linux signing secrets are configured in CI; full Linux desktop code-signing rollout remains tracked in FN-5605.
- Linux `.deb` and `.tar.gz` outputs are best-effort and may be absent on some runner images without failing the release.

### macOS code-signing and notarization

The macOS desktop release path signs and notarizes desktop bundles through electron-builder in CI.

- Required CI secrets:
  - `APPLE_CERTIFICATE_BASE64` (base64-encoded `.p12` Developer ID Application certificate)
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_ID`
  - `APPLE_TEAM_ID`
  - `APPLE_APP_PASSWORD` (mapped to electron-builder env var `APPLE_APP_SPECIFIC_PASSWORD`)
- Signing uses electron-builder `CSC_LINK` / `CSC_KEY_PASSWORD`.
- Notarization uses electron-builder + `xcrun notarytool` with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.
- With `mac.notarize: true`, CI verifies stapled notarization for `.dmg` and `.app` outputs.
- If `APPLE_CERTIFICATE_BASE64` is empty (for example forked PR contexts), the workflow still publishes unsigned `.dmg` / `.zip` via the unsigned step and passes `-c.mac.notarize=false`; signed verification is skipped in that path.
- Hardened runtime entitlements are pinned in `packages/desktop/build/entitlements.mac.plist`. Any entitlement changes require a follow-up task.
- Local signing/notarization is opt-in; developers can set the same env vars locally to mirror CI behavior.

### Linux signing

Every signed Linux desktop release includes `*.asc` detached signature sidecars alongside the binary artifacts.

Verification example:

```bash
gpg --import KEYS && gpg --verify Fusion-<version>-linux-x64.AppImage.asc Fusion-<version>-linux-x64.AppImage
```

The public key (`KEYS`) must be distributed out-of-band. See `docs/CODE_SIGNING.md` for canonical setup, key publication, and troubleshooting guidance.
- Isolated manual Windows build path: `.github/workflows/desktop-windows.yml` (`workflow_dispatch` on `windows-latest`) runs `electron-builder --win --x64 --arm64 --publish never`.
- ARM64 artifacts are cross-built on the `windows-latest` x64 runner; execution/validation still requires a Windows ARM64 device or emulator.
- Deep link protocol: `fusion://`
- Publish provider: GitHub (`gsxdsm/fusion`)

Run `pnpm --filter @fusion/desktop build` before `pack`/`dist` to ensure `dist/` assets are up to date.

### Windows code-signing

The Windows desktop workflow (`.github/workflows/desktop-windows.yml`) supports conditional Authenticode signing for NSIS + portable EXE outputs.

- Required CI secrets:
  - `WINDOWS_CERTIFICATE_BASE64` (base64-encoded `.pfx`)
  - `WINDOWS_CERTIFICATE_PASSWORD`
- Signing is handled directly by electron-builder using `CSC_LINK` and `CSC_KEY_PASSWORD`; no separate `signtool` wrapper script is invoked in this workflow.
- If signing secrets are not available (for example, forked PR contexts), the workflow still succeeds and uploads unsigned artifacts; the `Verify signed artifacts` step is skipped.
- Release-attached Windows `.exe` artifacts are currently unsigned in the binary publishing pipeline; code-signing automation for release workflows is tracked by FN-5592.
- Signing policy is pinned in `electron-builder.yml` (`sha256` digest + `http://timestamp.digicert.com`) to match `scripts/sign-windows.ps1` used by CLI binaries.
- Local signing is opt-in: developers who need signed local Windows builds must set `CSC_LINK`/`CSC_KEY_PASSWORD` in their own environment before invoking electron-builder.

## Environment

- `FUSION_DASHBOARD_URL` — override the default dashboard URL in development mode (`http://localhost:5173`)
- `FUSION_SERVER_PORT` — internal: port for embedded API server (set by CLI)
- `FUSION_ELECTRON_BINARY` — path to Electron binary (for testing)

## Build Pipeline

### Development Build (`pnpm --filter @fusion/desktop dev`)
1. Bundle `main.ts` and `preload.ts` with esbuild
2. Start dashboard Vite dev server
3. Launch Electron with `--dev` flag

### Production Build (`pnpm --filter @fusion/desktop build`)
1. Build dashboard client to `packages/dashboard/dist/client/`
2. Bundle `main.ts` and `preload.ts` with esbuild
3. Copy dashboard client to `packages/desktop/dist/client/`

### CLI Launch (`fn desktop`)
1. Build desktop artifacts (unless `--dev`)
2. Start the embedded API server and local AI engine on an ephemeral port
3. If `--paused` is set, keep the AI engine in an automation-paused state during startup
4. Launch Electron:
   - **Production:** Uses embedded renderer assets, `getServerPort()` for API connection
   - **Development (`--dev`):** Uses `FUSION_DASHBOARD_URL` for live reload

## Desktop Shell UI Components

- `src/renderer/components/DesktopWrapper.tsx` wraps the dashboard app for Electron-only chrome.
- `src/renderer/components/TitleBar.tsx` implements a custom frameless title bar with Fusion branding, drag region behavior, and window controls (minimize/maximize/close).
- The title bar styling lives in `src/renderer/components/TitleBar.css` and uses dashboard theme tokens (`--surface`, `--border`, `--text`, etc.).

## Desktop Hooks

Reusable renderer hooks in `src/renderer/hooks/` expose Electron runtime capabilities:

- `useElectron()` — runtime detection + typed `electronAPI` access
- `useAutoUpdate()` — update-available subscription + install trigger
- `useDeepLink()` — deep-link subscription and `fusion://task/...` / `fusion://project/...` parsing

## Renderer Entrypoint

- `src/renderer/index.html` mirrors dashboard theme initialization logic with Electron-safe defaults.
- `src/renderer/index.tsx` mounts the dashboard app in `StrictMode` and wraps it in `DesktopWrapper`.
- Unlike the web dashboard entry (`packages/dashboard/app/main.tsx`), this renderer entry does not register service workers and is intended for desktop-only bootstrapping.
