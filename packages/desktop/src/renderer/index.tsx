import React, { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopShellBootstrap } from "./components/DesktopShellBootstrap";

const dashboardStylesModulePath = "../../../../dashboard/app/styles.css";
const dashboardAppModulePath = "../../../../dashboard/app/App";

void import(/* @vite-ignore */ dashboardStylesModulePath).catch(() => {
  // Dashboard styles are loaded in the web app bundle; the desktop renderer
  // best-effort imports them for shared theming.
});

function RendererApp() {
  const [AppComponent, setAppComponent] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;

    void import(/* @vite-ignore */ dashboardAppModulePath)
      .then((module) => {
        if (!cancelled) {
          setAppComponent(() => (module as { App?: React.ComponentType }).App ?? null);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load dashboard App for desktop renderer", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!AppComponent) {
    return null;
  }

  return <DesktopShellBootstrap DashboardApp={AppComponent} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element for desktop renderer");
}

createRoot(rootElement).render(
  <StrictMode>
    <RendererApp />
  </StrictMode>,
);
