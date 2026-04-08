import React, { useEffect } from "react";
import type { PropsWithChildren } from "react";
import { TitleBar } from "./TitleBar";

function detectElectron(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean((window as Window & { electronAPI?: unknown }).electronAPI);
}

export function DesktopWrapper({ children }: PropsWithChildren) {
  const isElectron = detectElectron();

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    document.body.classList.add("fusion-desktop");
    return () => {
      document.body.classList.remove("fusion-desktop");
    };
  }, [isElectron]);

  if (!isElectron) {
    return <>{children}</>;
  }

  return (
    <div className="desktop-app-shell" data-testid="desktop-wrapper">
      <TitleBar />
      <div className="desktop-app-content">{children}</div>
    </div>
  );
}
