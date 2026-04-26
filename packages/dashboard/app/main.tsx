import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RootErrorBoundary } from "./components/ErrorBoundary";
import { App } from "./App";
import { installAuthFetch } from "./auth";
import { installVersionCheck } from "./versionCheck";
import "./styles.css";

// Install the bearer-token fetch wrapper before React mounts so every API
// call (including ones fired synchronously during the first render) picks up
// the token that was either captured from `?token=` in the launch URL or
// stored from a previous session.
installAuthFetch();
installVersionCheck();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      console.log("SW registered:", registration.scope);
    })
    .catch((error) => {
      console.log("SW registration failed:", error);
    });
}
