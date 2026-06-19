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
  },
  server: {
    url: liveReloadEnabled
      ? process.env.FUSION_SERVER_URL || "http://localhost:5173"
      : undefined,
    cleartext: liveReloadEnabled,
  },
};

export default config;
