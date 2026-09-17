import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RootErrorBoundary } from "./components/ErrorBoundary";
import { DesktopLaunchGate } from "./components/DesktopLaunchGate";
import { App } from "./App";
import { installAuthFetch } from "./auth";
import { installVersionCheck } from "./versionCheck";
import { installSwUpdate } from "./swUpdate";
import { bootstrapShellHostContext } from "./shell-host";
import { registerBundledPluginViews } from "./plugins/registerBundledPluginViews";
import { i18nReady } from "./i18n";
import "@fontsource/pixelify-sans/400.css";
import "./styles.css";
/*
FNXC:UiStyleAxis 2026-09-15-00:20:
The interface-style catalogue and the native presentation sheet are STATIC imports alongside the base
stylesheet, so a `data-ui-style` published by the pre-hydration bootstrap is already backed by real
declarations at first paint rather than by a deferred effect.
*/
import "./ui-style-tokens.css";
import "./native-ui.css";

/*
FNXC:AuthTokenRecovery 2026-09-10-21:28:
Install the bearer-token fetch wrapper before React mounts so first-render API calls receive the stored or launch-URL token and a daemon 401 can latch the full-screen recovery page before App's first render.
*/
installAuthFetch();
installVersionCheck();
bootstrapShellHostContext();
registerBundledPluginViews();

// Gate first paint on the active locale's catalogs so the UI never flashes raw
// translation keys. The catalog is a small local chunk, so this is a brief
// wait; `.finally` ensures we still render if i18n init fails (strings then
// fall back to keys/en rather than blocking the app).
void i18nReady.finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RootErrorBoundary>
        <DesktopLaunchGate>
          <App />
        </DesktopLaunchGate>
      </RootErrorBoundary>
    </StrictMode>,
  );

  installSwUpdate();
});
