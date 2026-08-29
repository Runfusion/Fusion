/**
 * Settings search highlight coordination.
 *
 * FNXC:SettingsSearch 2026-07-15-17:35:
 * Settings search returns individual settings, not just sections, so choosing a result has to land the operator on one control inside a section that may hold sixty of them. The modal owns which key is highlighted; every `SettingsFieldRow` reads that key and flags itself when it matches.
 * Context rather than prop-drilling: rows sit an arbitrary depth below the section component (inside cards, disclosures, and fieldsets), and threading a `highlightedKey` prop through all 34 sections would put a search concern into every intermediate component's signature.
 * The default value is a no-op highlight so a row rendered outside the provider — the WorkflowSettingsPanel reuses these primitives — behaves normally instead of throwing.
 */
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

export interface SettingsSearchHighlightValue {
  /** Setting key currently highlighted by a search result, or null. */
  highlightedKey: string | null;
}

const SettingsSearchHighlightContext = createContext<SettingsSearchHighlightValue>({
  highlightedKey: null,
});

export function SettingsSearchHighlightProvider({
  highlightedKey,
  children,
}: {
  highlightedKey: string | null;
  children: ReactNode;
}) {
  // Memoized so the provider does not re-render every consuming row on each
  // keystroke in the search box; only an actual change of key matters.
  const value = useMemo(() => ({ highlightedKey }), [highlightedKey]);
  return (
    <SettingsSearchHighlightContext.Provider value={value}>
      {children}
    </SettingsSearchHighlightContext.Provider>
  );
}

/** True when `key` is the setting a search result asked to highlight. */
export function useIsSettingHighlighted(key: string | undefined): boolean {
  const { highlightedKey } = useContext(SettingsSearchHighlightContext);
  return key !== undefined && key === highlightedKey;
}

export default SettingsSearchHighlightContext;
