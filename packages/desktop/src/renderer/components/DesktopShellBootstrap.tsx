import React, { useEffect, useMemo, useState } from "react";
import { DesktopWrapper } from "./DesktopWrapper";
import { DesktopModeChooser, type DesktopModeChoice } from "./DesktopModeChooser";

interface DesktopModeState {
  isFirstRun: boolean;
  desktopMode: DesktopModeChoice | null;
}

interface FusionShellWithModeApi {
  getDesktopModeState: () => Promise<DesktopModeState>;
  setDesktopMode: (mode: DesktopModeChoice) => Promise<unknown>;
}

function getFusionShell(): FusionShellWithModeApi | null {
  if (typeof window === "undefined") {
    return null;
  }

  const api = (window as Window & { fusionShell?: Partial<FusionShellWithModeApi> }).fusionShell;
  if (!api?.getDesktopModeState || !api?.setDesktopMode) {
    return null;
  }

  return api as FusionShellWithModeApi;
}

export function DesktopShellBootstrap({ DashboardApp }: { DashboardApp: React.ComponentType }) {
  const fusionShell = useMemo(() => getFusionShell(), []);
  const [modeState, setModeState] = useState<DesktopModeState | null>(null);

  useEffect(() => {
    if (!fusionShell) {
      setModeState({ isFirstRun: false, desktopMode: "local" });
      return;
    }

    let cancelled = false;
    void fusionShell.getDesktopModeState().then((state) => {
      if (!cancelled) {
        setModeState(state);
      }
    }).catch(() => {
      if (!cancelled) {
        setModeState({ isFirstRun: false, desktopMode: "local" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fusionShell]);

  const handleModeSelect = async (mode: DesktopModeChoice) => {
    if (fusionShell) {
      await fusionShell.setDesktopMode(mode);
    }
    setModeState({ isFirstRun: false, desktopMode: mode });
  };

  if (!modeState) {
    return null;
  }

  if (modeState.isFirstRun) {
    return (
      <DesktopWrapper>
        <DesktopModeChooser onSelectMode={handleModeSelect} />
      </DesktopWrapper>
    );
  }

  return (
    <DesktopWrapper>
      <DashboardApp />
    </DesktopWrapper>
  );
}
