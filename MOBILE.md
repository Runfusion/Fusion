# Mobile Development Guide

Fusion mobile builds package the dashboard web client into Capacitor shells via `packages/mobile/`.

## Prerequisites

- **Node.js** 22+
- **pnpm** 10+
- **Xcode** (iOS builds)
- **Android Studio** (Android SDK + emulator tooling)
- **Java JDK** 17+ (Android Gradle builds)

## Quick Start

```bash
pnpm install
pnpm mobile:build
pnpm mobile:ios      # open iOS project in Xcode
# or
pnpm mobile:android  # open Android project in Android Studio
```

## Development with Live Reload

Use the live-reload helpers in `packages/mobile/scripts/live-reload.ts`:

```bash
pnpm mobile:dev:ios
pnpm mobile:dev:android
```

These commands automatically set:

- `FUSION_LIVE_RELOAD=true`
- `FUSION_SERVER_URL=http://localhost:5173` (default)

To target a different dev server URL, set `FUSION_SERVER_URL` before running (or pass `--server-url` directly to the script):

```bash
FUSION_SERVER_URL=http://192.168.1.50:5173 pnpm mobile:dev:android
```

## Building for Production

```bash
pnpm mobile:build
```

This runs:

1. `pnpm --filter @fusion/dashboard build`
2. `pnpm --filter @fusion/mobile cap sync`

After sync, open native projects for release signing/distribution:

```bash
pnpm mobile:ios
pnpm mobile:android
```

## PWA Installation

The dashboard includes a PWA manifest (`packages/dashboard/app/public/manifest.json`) and service worker (`packages/dashboard/app/public/sw.js`).

### Standalone iOS home-indicator spacing

- Installed standalone mode sets `--standalone-bottom-gap` via `@media (display-mode: standalone) { :root { ... } }`.
- Bottom spacing must stay scoped to layout/component rules (for example mobile content padding and footer/nav offsets), not global `#root` padding.
- Keep standalone spacing additive with existing safe-area handling (`env(safe-area-inset-bottom, 0px)`).

Install from browser:

- **Chrome**: three-dot menu → **Install app**
- **Safari (iOS)**: **Share** → **Add to Home Screen**

> Service workers require **HTTPS** (or `localhost`). PWA install/offline behavior will not work on plain HTTP origins.

## Mobile UX Behavior

### Native shell onboarding and connection profiles

First launch in the mobile shell enters a shell-level remote connection onboarding flow before dashboard model onboarding.

For the canonical flow (QR/manual setup, saved profiles, active-profile behavior, and security caveats), see [Native Shell Connection Guide](./docs/native-shell.md).

Implementation notes:
- Mobile shell profiles are persisted in shell-local storage (Capacitor Preferences), separate from Fusion project/global settings.
- The dashboard consumes this through the shared `window.fusionShell` connection APIs.

### Planning Mode

Planning Mode opens directly into the composer pane on mobile when no planning sessions exist, avoiding an empty-sidebar dead end. On desktop/tablet the split view is unaffected. Once sessions are saved, mobile shows the session list as usual and the user can navigate between list and detail panes.

### Chat and Quick Chat mobile scroll/readability behavior

- Chat and Quick Chat must keep scrolling container-scoped (`.chat-messages` / `.quick-chat-panel-messages`) and must not switch to page-level scroll APIs (including `scrollIntoView()`) to avoid mobile Safari viewport drift.
- Both surfaces now pause live-tail autoscroll when the user scrolls away from bottom, show a temporary **Latest** jump control, and resume tail-follow only after jumping back.
- Mobile bubble widths are intentionally slightly wider for readability, but safe-area padding, full-screen Quick Chat bounds, and compact mobile tool-call summaries must remain intact.

## CI/CD Pipeline

Mobile CI is defined in `.github/workflows/mobile.yml`.

- Trigger manually via **GitHub Actions → Mobile Builds → Run workflow**
- Also runs on push to `main` when files under `packages/mobile/**` or `packages/dashboard/**` change
- Jobs:
  - `build-web` (build dashboard and upload `dist/client`)
  - `build-ios` (sync/build iOS when `packages/mobile/ios/` exists)
  - `build-android` (sync/build Android when `packages/mobile/android/` exists)

Artifacts are retained for 30 days.

## Replacing PWA Icons

Current icons are placeholders:

- `packages/dashboard/app/public/icons/icon-192.png`
- `packages/dashboard/app/public/icons/icon-512.png`

Generate production icons from `logo.svg` (example with sharp-cli):

```bash
npx sharp-cli -i packages/dashboard/app/public/logo.svg -o packages/dashboard/app/public/icons/icon-192.png resize 192 192
npx sharp-cli -i packages/dashboard/app/public/logo.svg -o packages/dashboard/app/public/icons/icon-512.png resize 512 512
```

You can also use ImageMagick if preferred.

## Troubleshooting

### `cap sync` fails

- Confirm dependencies are installed: `pnpm install`
- Ensure platform projects have been added (`packages/mobile/ios` / `packages/mobile/android`)
- Re-run: `pnpm mobile:sync`

### iOS build fails

- Verify Xcode version/toolchain compatibility
- Open `packages/mobile/ios/App/App.xcworkspace` in Xcode and resolve signing settings

### Android build fails

- Verify Java 17+ (`java -version`)
- Confirm Android SDK and Gradle tooling are installed via Android Studio

### PWA does not install

- Verify HTTPS (or localhost)
- Confirm `manifest.json` and `sw.js` are served from the built app
- Clear old service worker/cache and reload

## Script Reference

Root scripts (`package.json`):

- `mobile:build`
- `mobile:ios`
- `mobile:android`
- `mobile:dev:ios`
- `mobile:dev:android`
- `mobile:sync`

Mobile package scripts (`packages/mobile/package.json`):

- `cap`
- `dev:ios`
- `dev:android`
- `build:mobile`
