import { createContext, useContext, useMemo, type PropsWithChildren } from "react";
import { getShellHostContext, type ShellHostContext } from "../shell-host";

export interface ShellHostContextValue {
  host: ShellHostContext;
  isNativeShell: boolean;
  kind: ShellHostContext["kind"];
  mode?: "local" | "remote";
  connectionId?: string;
  serverUrl?: string;
  canOpenConnectionManager?: boolean;
}

const DEFAULT_HOST: ShellHostContext = { kind: "browser" };

const ShellHostContextReact = createContext<ShellHostContextValue>({
  host: DEFAULT_HOST,
  isNativeShell: false,
  kind: "browser",
});

function buildValue(host: ShellHostContext): ShellHostContextValue {
  const isNativeShell = host.kind !== "browser";
  return {
    host,
    isNativeShell,
    kind: host.kind,
    ...(isNativeShell ? {
      mode: host.mode,
      connectionId: host.connectionId,
      serverUrl: host.serverUrl,
      canOpenConnectionManager: host.canOpenConnectionManager,
    } : {}),
  };
}

export function ShellHostProvider({ children }: PropsWithChildren) {
  const value = useMemo(() => buildValue(getShellHostContext()), []);
  return <ShellHostContextReact.Provider value={value}>{children}</ShellHostContextReact.Provider>;
}

export function useShellHostContext(): ShellHostContextValue {
  return useContext(ShellHostContextReact);
}
