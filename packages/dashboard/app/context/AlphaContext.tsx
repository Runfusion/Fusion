import { createContext, useContext, useMemo, type ReactNode } from "react";

interface AlphaState {
  enabled: boolean;
  surfaceActive: boolean;
}

const AlphaContext = createContext<AlphaState>({ enabled: false, surfaceActive: false });

/*
FNXC:HomemadeAlpha 2026-09-11-16:14:
Alpha presentation is owned by Fusion's native React and HTML controls. The provider publishes the resolved feature flag without adding a layout box, while explicit boundaries keep shared controls outside Board, Chat, and Task Detail unchanged.
*/
export function AlphaProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ enabled, surfaceActive: false }), [enabled]);
  return <AlphaContext.Provider value={value}>{children}</AlphaContext.Provider>;
}

export function AlphaBoundary({
  children,
  enabled,
  preserveDisabledDom = false,
  className,
}: {
  children: ReactNode;
  enabled?: boolean;
  preserveDisabledDom?: boolean;
  className?: string;
}) {
  const parent = useContext(AlphaContext);
  const resolvedEnabled = enabled ?? parent.enabled;
  const value = useMemo(
    () => ({ enabled: resolvedEnabled, surfaceActive: resolvedEnabled }),
    [resolvedEnabled],
  );

  /*
  FNXC:AlphaBoundaryLayout 2026-09-11-16:14:
  Shared Alpha hosts keep their canonical flex and scroll owners. The boundary is layout-transparent, so toggling Alpha never inserts a height-constraining wrapper or remounts the host's stateful content.
  */
  if (!resolvedEnabled && preserveDisabledDom) return <>{children}</>;
  return (
    <AlphaContext.Provider value={value}>
      <div className={className} data-alpha-surface={value.surfaceActive ? "true" : undefined}>{children}</div>
    </AlphaContext.Provider>
  );
}

export function useAlphaSurface(): boolean {
  return useContext(AlphaContext).surfaceActive;
}
