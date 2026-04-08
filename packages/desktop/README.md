# @fusion/desktop

Electron desktop shell for Fusion.

This package provides a native Electron wrapper around the existing Fusion dashboard web UI. The desktop shell connects to a running dashboard server and presents native desktop affordances including a system tray and application menu.

## Prerequisites

Start the Fusion dashboard server first:

```bash
fn dashboard
```

Then, in another terminal, start the desktop app:

```bash
pnpm --filter @fusion/desktop dev
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

- **macOS:** App, Edit, View, Window, and Help menus.
- **Windows/Linux:** Edit, View, Window, and Help (no App menu).
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
  - `setupAutoUpdater(mainWindow?)` configures `electron-updater`, checks for updates, and relays `update-available` / `update-downloaded` events to the renderer via IPC.
  - Failures are logged and treated as non-fatal (important for unsigned/local dev builds).
- **Window state persistence**
  - `loadWindowState()` reads `window-state.json` from `app.getPath("userData")`.
  - `saveWindowState(mainWindow)` writes bounds/maximized state atomically (`.tmp` + rename).
  - `DEFAULT_WINDOW_STATE` is the fallback (`1280x900`, not maximized).

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
| `loadWindowState` | `() => Promise<WindowState \| null>` |
| `saveWindowState` | `(mainWindow) => void` |
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

- `pnpm --filter @fusion/desktop dev` — run the Electron main process in development
- `pnpm --filter @fusion/desktop build` — compile TypeScript sources
- `pnpm --filter @fusion/desktop test` — run Vitest suite
- `pnpm --filter @fusion/desktop typecheck` — run TypeScript checks without emitting files
- `pnpm --filter @fusion/desktop generate:icons` — regenerate tray icon PNG assets from the dashboard logo SVG
- `pnpm --filter @fusion/desktop pack` — build distributable package via electron-builder
- `pnpm --filter @fusion/desktop dist` — build distribution artifacts without publishing

## Environment

- `FUSION_DASHBOARD_URL` — override the default dashboard URL used by the desktop shell (`http://localhost:4040`)

## Renderer Architecture

The desktop package now includes a renderer layer under `src/renderer/` that adapts the dashboard UI for Electron while preserving web-dashboard compatibility.

### Electron-aware API transport

- `src/renderer/api-electron.ts` provides `createApiClient()` with runtime detection.
- In browser/web contexts, it uses a standard fetch transport.
- In Electron contexts, it uses an IPC transport (`electronAPI.invoke("api-request", ...)`) and can resolve the dashboard server port dynamically via `electronAPI.getServerPort()`.

### Desktop shell UI components

- `src/renderer/components/DesktopWrapper.tsx` wraps the dashboard app for Electron-only chrome.
- `src/renderer/components/TitleBar.tsx` implements a custom frameless title bar with Fusion branding, drag region behavior, and window controls (minimize/maximize/close).
- The title bar styling lives in `src/renderer/components/TitleBar.css` and uses dashboard theme tokens (`--surface`, `--border`, `--text`, etc.).

### Desktop hooks

Reusable renderer hooks in `src/renderer/hooks/` expose Electron runtime capabilities:

- `useElectron()` — runtime detection + typed `electronAPI` access
- `useAutoUpdate()` — update-available subscription + install trigger
- `useDeepLink()` — deep-link subscription and `fusion://task/...` / `fusion://project/...` parsing

### Renderer entrypoint

- `src/renderer/index.html` mirrors dashboard theme initialization logic with Electron-safe defaults.
- `src/renderer/index.tsx` mounts the dashboard app in `StrictMode` and wraps it in `DesktopWrapper`.
- Unlike the web dashboard entry (`packages/dashboard/app/main.tsx`), this renderer entry does not register service workers and is intended for desktop-only bootstrapping.
