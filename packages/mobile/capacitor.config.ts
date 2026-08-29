/// <reference types="@capacitor-community/safe-area" />
import type { CapacitorConfig } from "@capacitor/cli";

const liveReloadEnabled = process.env.FUSION_LIVE_RELOAD === "true";

const config: CapacitorConfig = {
  appId: "com.fusion.mobile",
  appName: "Fusion",
  webDir: "../dashboard/dist/client",
  // FNXC:MobileShell 2026-06-16-19:20: status-bar overlap fix.
  // The mobile app is a thin Capacitor webview wrapping the Fusion dashboard,
  // often loaded REMOTELY (server.url). Relying on env(safe-area-inset-*) in the
  // served CSS is fragile: it depends on the device Chromium version reporting
  // insets AND on the (cacheable, service-worker-backed) dashboard CSS being
  // current. Instead we force @capacitor-community/safe-area to pad the WHOLE
  // webview natively on every Android device. Per the plugin docs, setting both
  // flags false makes it "only add padding around the webview on all Android
  // devices" and stop passing insets through, so the app can never render under
  // the status/navigation bars regardless of CSS or webview version.
  plugins: {
    SafeArea: {
      detectViewportFitCoverChanges: false,
      initialViewportFitCover: false,
    },
    // FNXC:TaskDetailAndroidBack 2026-07-05-11:40:
    // FN-7583: keep the @capacitor/app native backButton handler ENABLED (the default,
    // pinned explicitly below). `AndroidBackButtonManager` in `src/plugins/native-shell.ts`
    // relies on the plugin's "backButton" event to dispatch the shared `fusion:native-back`
    // event that the dashboard's nav-history stack consumes for both the hardware Back
    // button and the Android 13+ predictive-back GESTURE (once the gesture is actually
    // delivered — see `scripts/patch-android-manifest.ts` for the manifest opt-in that
    // makes that so). Setting `disableBackButtonHandler: true` would stop the plugin from
    // emitting "backButton" entirely, breaking BOTH the button and the gesture routing —
    // never flip this without replacing `AndroidBackButtonManager`'s dispatch seam too.
    App: {
      disableBackButtonHandler: false,
    },
  },
  server: {
    url: liveReloadEnabled
      ? process.env.FUSION_SERVER_URL || "http://localhost:5173"
      : undefined,
    cleartext: liveReloadEnabled,
  },
};

export default config;
