# Mobile Development Guide

Fusion mobile builds package the dashboard web client into Capacitor shells via `packages/mobile/`.

## Prerequisites

- **Node.js** 22+
- **pnpm** 10+
- **Xcode** (iOS builds)
- **Android Studio** (Android SDK + emulator tooling)
- **Java JDK** 21+ (Android Gradle builds)

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
- The `.project-content` wrapper is the single source of truth for mobile-nav/footer/standalone bottom reservation; inline dashboard tabs (for example Agents and Missions) must only apply their own content padding and must not re-add `--mobile-nav-height` or duplicate footer spacing.

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
- Active-profile deletion fallback is shell-owned: deleting the active profile promotes the first remaining profile, and deleting the final profile resets to a clean empty state.
- The dashboard consumes this through the shared `window.fusionShell` connection APIs.

### Native Back Handling (Android Back + iOS Edge-Swipe-Back)

Task-detail dismissal via native "back" (Android hardware Back / predictive-back gesture,
iOS edge-swipe-back, or plain browser swipe-back) converges on a single shared invariant:
the dashboard's `useNavigationHistory` nav-history stack. See `packages/mobile/README.md`
→ "Native Back Handling" for the full Android (`fusion:native-back`) vs. iOS (`popstate`)
routing details and the tracked post-`cap sync` patch scripts (`scripts/
patch-android-manifest.ts`, `scripts/patch-ios-webview.ts`) that keep each platform's native
gesture delivery enabled across `cap sync` regenerations.

### Planning Mode

Planning Mode opens directly into the composer pane on mobile when no planning sessions exist, avoiding an empty-sidebar dead end. Every viewport uses the same sequential surface: idea, generated initial plan, then optional refinement questions. Plan review offers model-suggested focus choices plus **Write your own focus**, followed by **Refine** and **Validate**; refine asks one question and validate creates the task. Generation remains resumable across refreshes, and answer turns visibly report **Updating plan…** before returning to review. There is no three-pane interview or Question/Running plan/Answered questions tab switcher. On mobile, opening Planning with saved sessions lands on the full-pane, scrollable saved-session list with **New session** as its footer. **Sessions** and the mobile back control always return to that list, including from plan review and create retry.

### Chat and Quick Chat mobile scroll/readability behavior

- Chat and Quick Chat must keep scrolling container-scoped (`.chat-messages` / `.quick-chat-panel-messages`) and must not switch to page-level scroll APIs (including `scrollIntoView()`) to avoid mobile Safari viewport drift.
- Full Chat direct-thread mobile headers include a title-triggered quick session switcher; preserve one-pane behavior (back-to-list still works) and keep the switcher scoped to direct sessions only (room threads keep existing room header/back behavior).
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

Artifacts from the Mobile Builds workflow are retained for 30 days. Tagged binary releases also run the Android build leg in `.github/workflows/release.yml`; `.github/workflows/test-release.yml` mirrors that path in its tag-less rehearsal artifact.

When the repository has Android signing secrets configured (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), the release pipeline publishes signed `fusion-android-release.apk` and `fusion-android-release.aab` assets plus `.sha256` checksums. Without those secrets, the pipeline preserves the secret-free fallback and publishes the unsigned debug APK as `fusion-android.apk` plus `fusion-android.apk.sha256`.

Install the signed APK by enabling **Install unknown apps** for the transfer source on the device, then sideloading it:

```bash
adb install fusion-android-release.apk
```

Verify the APK signer before distribution when Android SDK build-tools are available:

```bash
apksigner verify --print-certs fusion-android-release.apk
```

The `.aab` file is for Play distribution and is not directly sideloadable with `adb install`. Automated Play Store / Play Console upload remains out of scope for now because it needs a Google service-account JSON secret, a published Play listing, and fastlane or `r0adkll/upload-google-play` wiring; that work is tracked separately in FN-7043 from the sideload-first release assets.

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

- Verify Java 21+ (`java -version`)
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
- `patch:ios-webview` — idempotently enables the iOS WKWebView edge-swipe-back gesture in the generated `ios/App/App/AppDelegate.swift` (safe no-op if `ios/` doesn't exist yet)
- `capacitor:sync:after` — Capacitor's own post-`cap sync` hook; currently runs the iOS webview patch so `cap sync` regeneration can't silently drop the gesture opt-in
