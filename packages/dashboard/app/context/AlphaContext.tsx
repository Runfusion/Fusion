import { createContext, useContext, useMemo, type ReactNode } from "react";

interface AlphaState {
  enabled: boolean;
  surfaceActive: boolean;
}

const AlphaContext = createContext<AlphaState>({ enabled: true, surfaceActive: false });

/*
FNXC:OfficialDashboardDesign 2026-09-13-00:38:
Fusion's native Alpha presentation is now the official dashboard design. The provider keeps boundaries layout-transparent while every Board, Chat, and Task Detail boundary remains active regardless of stale persisted alphaUpdates values.
*/
export function AlphaProvider({ children }: { children: ReactNode; enabled?: boolean }) {
  const value = useMemo(() => ({ enabled: true, surfaceActive: false }), []);
  return <AlphaContext.Provider value={value}>{children}</AlphaContext.Provider>;
}

export function AlphaBoundary({
  children,
  className,
}: {
  children: ReactNode;
  enabled?: boolean;
  preserveDisabledDom?: boolean;
  className?: string;
}) {
  const value = useMemo(() => ({ enabled: true, surfaceActive: true }), []);

  /* FNXC:OfficialDashboardDesign 2026-09-13-00:38: Official-design boundaries always publish the active marker and retain their canonical flex and scroll owners. */
  return (
    <AlphaContext.Provider value={value}>
      <div className={className} data-alpha-surface="true">{children}</div>
    </AlphaContext.Provider>
  );
}

export function useAlphaSurface(): boolean {
  return useContext(AlphaContext).surfaceActive;
}
