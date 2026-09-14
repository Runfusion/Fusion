import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getScopedItem, scopedKey, setScopedItem } from "../utils/projectStorage";

export const VIEW_SIDEBAR_STORAGE_KEY = "kb-dashboard-view-sidebar-width";
export const VIEW_SIDEBAR_DEFAULT_WIDTH = 300;
export const VIEW_SIDEBAR_MIN_WIDTH = 220;
export const VIEW_SIDEBAR_MAX_WIDTH = 560;

export function clampViewSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return VIEW_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(VIEW_SIDEBAR_MAX_WIDTH, Math.max(VIEW_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function parseViewSidebarWidth(value: string | null | undefined): number {
  if (typeof value !== "string" || value.trim().length === 0) return VIEW_SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampViewSidebarWidth(parsed) : VIEW_SIDEBAR_DEFAULT_WIDTH;
}

function readProjectSidebarWidth(projectId?: string): number {
  if (!projectId) return VIEW_SIDEBAR_DEFAULT_WIDTH;
  return parseViewSidebarWidth(getScopedItem(VIEW_SIDEBAR_STORAGE_KEY, projectId));
}

export interface ViewLayoutContextValue {
  projectId?: string;
  scopeIdentity: string;
  preferredSidebarWidth: number;
  previewSidebarWidth: (width: number) => number;
  commitSidebarWidth: (width: number) => number;
}

export const ViewLayoutContext = createContext<ViewLayoutContextValue | null>(null);

interface ScopedViewLayoutProviderProps {
  projectId?: string;
  children: ReactNode;
}

/*
FNXC:StandardizedViewLayout 2026-09-13-16:12:
Every dashboard collection shares one project-scoped sidebar preference. The provider keeps live consumers synchronized, treats browser storage as optional restoration state, and never falls back to an unscoped key while project identity is absent.

FNXC:StandardizedViewLayout 2026-09-13-16:12:
Changing projects remounts the scoped state before descendants render, so a late resize from project A cannot preview or persist into project B. Storage events update only the matching project and never echo a write back to storage.
*/
function ScopedViewLayoutProvider({ projectId, children }: ScopedViewLayoutProviderProps) {
  const [preferredSidebarWidth, setPreferredSidebarWidth] = useState(() => readProjectSidebarWidth(projectId));

  const previewSidebarWidth = useCallback((width: number) => {
    const next = clampViewSidebarWidth(width);
    setPreferredSidebarWidth(next);
    return next;
  }, []);

  const commitSidebarWidth = useCallback((width: number) => {
    const next = clampViewSidebarWidth(width);
    setPreferredSidebarWidth(next);
    if (projectId) {
      setScopedItem(VIEW_SIDEBAR_STORAGE_KEY, String(next), projectId);
    }
    return next;
  }, [projectId]);

  useEffect(() => {
    if (!projectId || typeof window === "undefined") return;
    const expectedKey = scopedKey(VIEW_SIDEBAR_STORAGE_KEY, projectId);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== expectedKey) return;
      setPreferredSidebarWidth(parseViewSidebarWidth(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [projectId]);

  const value = useMemo<ViewLayoutContextValue>(() => ({
    projectId,
    scopeIdentity: projectId ? `project:${projectId}` : "project:none",
    preferredSidebarWidth,
    previewSidebarWidth,
    commitSidebarWidth,
  }), [commitSidebarWidth, preferredSidebarWidth, previewSidebarWidth, projectId]);

  return <ViewLayoutContext.Provider value={value}>{children}</ViewLayoutContext.Provider>;
}

export interface ViewLayoutProviderProps {
  projectId?: string;
  children: ReactNode;
}

export function ViewLayoutProvider({ projectId, children }: ViewLayoutProviderProps) {
  return (
    <ScopedViewLayoutProvider key={projectId || "__no-project__"} projectId={projectId}>
      {children}
    </ScopedViewLayoutProvider>
  );
}
