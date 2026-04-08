import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./TitleBar.css";

type WindowControlAction = "minimize" | "maximize" | "close" | "isMaximized";

type Platform = "darwin" | "win32" | "linux";

interface ElectronApiForTitleBar {
  windowControl?: (action: WindowControlAction) => Promise<boolean | void>;
  getPlatform?: () => Promise<Platform>;
}

function getElectronApi(): ElectronApiForTitleBar | null {
  if (typeof window === "undefined") {
    return null;
  }

  const maybeApi = (window as Window & { electronAPI?: ElectronApiForTitleBar }).electronAPI;
  return maybeApi ?? null;
}

export function TitleBar() {
  const electronApi = getElectronApi();
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    if (!electronApi?.windowControl) {
      return;
    }

    void electronApi.windowControl("isMaximized").then((value) => {
      setIsMaximized(Boolean(value));
    }).catch(() => {
      setIsMaximized(false);
    });
  }, [electronApi]);

  useEffect(() => {
    if (!electronApi?.getPlatform) {
      return;
    }

    void electronApi.getPlatform().then(setPlatform).catch(() => {
      setPlatform(null);
    });
  }, [electronApi]);

  const handleWindowControl = useCallback(async (action: Exclude<WindowControlAction, "isMaximized">) => {
    if (!electronApi?.windowControl) {
      return;
    }

    const result = await electronApi.windowControl(action);
    if (action === "maximize") {
      if (typeof result === "boolean") {
        setIsMaximized(result);
      } else {
        setIsMaximized((prev) => !prev);
      }
    }
  }, [electronApi]);

  const handleTitleDoubleClick = useCallback(() => {
    void handleWindowControl("maximize");
  }, [handleWindowControl]);

  const maximizeGlyph = useMemo(() => (isMaximized ? "⧉" : "□"), [isMaximized]);
  const controlsOnLeft = platform === "darwin";

  const controls = (
    <div className="desktop-titlebar__controls desktop-titlebar__controls--no-drag">
      <button
        type="button"
        className="desktop-titlebar__control"
        onClick={() => void handleWindowControl("minimize")}
        aria-label="Minimize window"
        title="Minimize"
        data-testid="titlebar-minimize"
      >
        −
      </button>
      <button
        type="button"
        className="desktop-titlebar__control"
        onClick={() => void handleWindowControl("maximize")}
        aria-label={isMaximized ? "Restore window" : "Maximize window"}
        title={isMaximized ? "Restore" : "Maximize"}
        data-testid="titlebar-maximize"
      >
        {maximizeGlyph}
      </button>
      <button
        type="button"
        className="desktop-titlebar__control desktop-titlebar__control--close"
        onClick={() => void handleWindowControl("close")}
        aria-label="Close window"
        title="Close"
        data-testid="titlebar-close"
      >
        ×
      </button>
    </div>
  );

  return (
    <header
      className="desktop-titlebar desktop-titlebar--drag"
      onDoubleClick={handleTitleDoubleClick}
      data-testid="desktop-titlebar"
    >
      {controlsOnLeft ? controls : null}
      <div className="desktop-titlebar__brand">
        <svg className="desktop-titlebar__logo" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="5" cy="5" r="2.5" fill="currentColor" />
          <circle cx="11" cy="5" r="2.5" fill="currentColor" />
          <circle cx="5" cy="11" r="2.5" fill="currentColor" />
          <circle cx="11" cy="11" r="2.5" fill="currentColor" />
        </svg>
        <span className="desktop-titlebar__title">Fusion</span>
      </div>
      {controlsOnLeft ? null : controls}
    </header>
  );
}
