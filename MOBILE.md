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

### Soft-keyboard geometry: one measurement, one owner

When the virtual keyboard opens, Fusion decides where the visible area ends **once**, from one shared
measurement, and lets exactly **one** container per surface act on it.

**The measurement.** `packages/dashboard/app/utils/mobileKeyboardViewport.ts` reads a single atomic
frame — layout viewport, visual viewport, offsets, scale, and whether an editable element holds focus
— and publishes it to every consumer through one shared subscription. The canonical value is the
*visible rectangle expressed in layout coordinates*: its bottom edge is `offsetTop + height`, which is
the same coordinate space `getBoundingClientRect()` reports. The residual bottom inset of a
layout-anchored element is `max(0, layoutHeight - visibleBottom)`, and it is **zero** when the browser
has already shrunk the layout viewport with the keyboard (Android Chrome with
`interactive-widget=resizes-content`, which `app/index.html` sets).

Two browsers, one rule:

| | layout viewport | visual viewport | residual inset |
| --- | --- | --- | --- |
| iOS / WebKit | unchanged | shrinks | the occluded band |
| Android `resizes-content` | shrinks | shrinks | `0` — nothing is hidden |

**The owner.** `app/hooks/useKeyboardViewportSurface.ts` adapts one container, matched to how that
container is anchored:

- `anchor: "measured"` — a top-anchored container (a floating window positioned by `top`, a region in
  normal flow). Its top does not move when its height changes, so the height is capped at
  `visibleBottom - top`. It never grows a container.
- `anchor: "layout-bottom"` — a container anchored to the bottom of the layout viewport, like the
  mobile drawer overlay. Shortening it moves its own top, so a height derived from that top feeds back
  into itself; the bottom inset is taken straight from the frame instead, with no measurement at all.

Ownership is published through React context: a descendant inside an adapted ancestor adapts nothing
and simply fits through the flex column and its own scroller. `MobileDrawer`, `FloatingWindow`, and
`TerminalModal` are the owners; Chat, forms, and terminals are content.

**Detection is separate from placement.** `useMobileKeyboard` still answers "is a keyboard up?"
heuristically (focused editable element plus a shrink against a closed baseline), because that genuinely
cannot be measured. A baseline may *qualify* a transition; it may never *supply* placement pixels.
Pinch and accessibility zoom shrink the visual viewport too and are never treated as occlusion.

**Local reveal, never a page scroll.** `app/utils/scrollFocusedControlWithin.ts` brings a focused
control into view by scrolling its own nearest scroller by the minimum amount. It refuses unless the
element is still the focused, connected control, so a callback from a form the user already left cannot
move the surface they are now using. `scrollIntoView({ block: "center" })` is deliberately not used:
it scrolls every ancestor up to the document, and a document scroll during a WebKit keyboard raise can
abort the raise.

**Safe area.** The bottom system inset and the navigation reserve are dropped only while the keyboard
genuinely covers that region, and restored exactly at rest. WebKit can keep reporting a bottom safe
area with the keyboard up ([WebKit #217754](https://bugs.webkit.org/show_bug.cgi?id=217754)), so it is
reserved once and never twice.

**No constant compensations.** There is no fixed accessory-bar margin, no user-agent test, and no
`navigator.virtualKeyboard.overlaysContent`. A previous constant iOS margin was the direct cause of the
empty band operators saw between the keyboard and the composer; it was removed rather than retuned. If
the iOS input-assistant bar ever needs compensating, it must come from observable geometry.

**Validation limits.** The automated coverage is Vitest/jsdom for state, ownership, and cancellation,
plus a real-Chromium lane that drives *simulated* viewport metrics against real CSS
(`packages/dashboard/src/__tests__/mobile-keyboard-browser.test.ts`). Neither triggers a real iOS or
Android keyboard. Physical-device validation on Safari/iOS, Chrome/Android, the installed PWA, and the
Capacitor shell remains desirable and has **not** been performed for this work — WebKit can publish the
settled height late in the keyboard animation
([WebKit #265578](https://bugs.webkit.org/show_bug.cgi?id=265578)), which only a real device exercises.
The Capacitor wrapper adds no keyboard plugin; it serves the same dashboard and inherits this behaviour.

### Chat and Quick Chat mobile scroll/readability behavior

- Chat and Quick Chat must keep scrolling container-scoped (`.chat-messages` / `.quick-chat-panel-messages`) and must not switch to page-level scroll APIs (including `scrollIntoView()`) to avoid mobile Safari viewport drift. Use `scrollFocusedControlWithin` when a focused control must be revealed; it is bounded to that control's own scroller.
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
