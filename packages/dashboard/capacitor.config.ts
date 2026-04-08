import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.fusion.dashboard",
  appName: "Fusion",
  webDir: "dist/client",
  server: {
    // In development, override url to connect to the Fusion backend.
    // Set FUSION_BACKEND_URL env var before running cap sync/run.
    // Example: FUSION_BACKEND_URL=http://192.168.1.100:4040 pnpm cap:run:ios
    //
    // In production, the app serves static assets from webDir and connects
    // to the backend at the configured server url.
    url: process.env.FUSION_BACKEND_URL || undefined,
    cleartext: true, // Allow HTTP connections to local dev servers
    iosScheme: "fusion",
    androidScheme: "fusion",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#0a0a0a",
      showSpinner: true,
      spinnerColor: "#6366f1",
      androidSplashAssetName: "splash",
      androidScaleType: "CENTER_CROP",
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0a0a0a",
    },
  },
};

export default config;
