import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { FusionShellApi, ShellConnectionState } from "../types/native-shell";

export interface ShellContextValue {
  shellApi: FusionShellApi | null;
  state: ShellConnectionState;
  ready: boolean;
  openConnectionManagerSignal: number;
}

const DEFAULT_STATE: ShellConnectionState = {
  host: "web",
  activeProfileId: null,
  profiles: [],
};

const ShellContext = createContext<ShellContextValue>({
  shellApi: null,
  state: DEFAULT_STATE,
  ready: true,
  openConnectionManagerSignal: 0,
});

export function ShellProvider({ children }: PropsWithChildren) {
  const shellApi = useMemo(() => (typeof window !== "undefined" ? window.fusionShell ?? null : null), []);
  const [state, setState] = useState<ShellConnectionState>(DEFAULT_STATE);
  const [ready, setReady] = useState(!shellApi);
  const [openConnectionManagerSignal, setOpenConnectionManagerSignal] = useState(0);

  useEffect(() => {
    if (!shellApi) {
      return;
    }

    let cancelled = false;
    void shellApi.getState().then((value) => {
      if (!cancelled) {
        setState(value);
        setReady(true);
      }
    });

    const unsubscribe = shellApi.subscribe((nextState) => {
      setState(nextState);
    });

    const handleOpenConnectionManager = () => {
      setOpenConnectionManagerSignal((value) => value + 1);
    };
    window.addEventListener("shell:open-connection-manager", handleOpenConnectionManager);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("shell:open-connection-manager", handleOpenConnectionManager);
    };
  }, [shellApi]);

  return <ShellContext.Provider value={{ shellApi, state, ready, openConnectionManagerSignal }}>{children}</ShellContext.Provider>;
}

export function useShellContext(): ShellContextValue {
  return useContext(ShellContext);
}
