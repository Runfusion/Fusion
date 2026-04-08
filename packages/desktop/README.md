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
