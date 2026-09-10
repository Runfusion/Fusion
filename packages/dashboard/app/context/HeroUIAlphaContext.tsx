import { createContext, useContext, useMemo, type ReactNode } from "react";

interface HeroUIAlphaState {
  enabled: boolean;
  surfaceActive: boolean;
}

const HeroUIAlphaContext = createContext<HeroUIAlphaState>({ enabled: false, surfaceActive: false });

/*
FNXC:HeroUIAlpha 2026-09-10-17:46:
HeroUI v3 is an Alpha-only presentation layer for Board and Chat. The app publishes the single resolved flag here, while an explicit surface boundary prevents shared controls used by List, Mailbox, plugins, or ordinary Task Detail from changing presentation.
*/
export function HeroUIAlphaProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ enabled, surfaceActive: false }), [enabled]);
  return <HeroUIAlphaContext.Provider value={value}>{children}</HeroUIAlphaContext.Provider>;
}

export function HeroUIAlphaSurface({ children, enabled }: { children: ReactNode; enabled?: boolean }) {
  const parent = useContext(HeroUIAlphaContext);
  const resolvedEnabled = enabled ?? parent.enabled;
  const value = useMemo(
    () => ({ enabled: resolvedEnabled, surfaceActive: resolvedEnabled }),
    [resolvedEnabled],
  );
  return (
    <HeroUIAlphaContext.Provider value={value}>
      <div data-heroui-alpha-surface={value.surfaceActive ? "true" : undefined}>{children}</div>
    </HeroUIAlphaContext.Provider>
  );
}

export function useHeroUIAlpha(): boolean {
  return useContext(HeroUIAlphaContext).surfaceActive;
}
