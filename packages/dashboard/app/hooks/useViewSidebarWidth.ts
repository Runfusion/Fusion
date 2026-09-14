import { useCallback, useContext, useMemo, useState } from "react";
import {
  VIEW_SIDEBAR_DEFAULT_WIDTH,
  VIEW_SIDEBAR_MAX_WIDTH,
  VIEW_SIDEBAR_MIN_WIDTH,
  ViewLayoutContext,
  clampViewSidebarWidth,
} from "../context/ViewLayoutContext";

export interface UseViewSidebarWidthOptions {
  /** A host may temporarily reduce the rendered width without rewriting the shared preference. */
  hostMinWidth?: number;
  /** A host may temporarily reduce the rendered width without rewriting the shared preference. */
  hostMaxWidth?: number;
}

export interface ViewSidebarWidthController {
  width: number;
  preferredWidth: number;
  minWidth: number;
  maxWidth: number;
  scopeIdentity: string;
  projectId?: string;
  previewWidth: (width: number) => number;
  commitWidth: (width: number) => number;
}

function resolveHostBounds(options: UseViewSidebarWidthOptions): { minWidth: number; maxWidth: number } {
  const requestedMin = Number.isFinite(options.hostMinWidth)
    ? clampViewSidebarWidth(options.hostMinWidth as number)
    : VIEW_SIDEBAR_MIN_WIDTH;
  const requestedMax = Number.isFinite(options.hostMaxWidth)
    ? clampViewSidebarWidth(options.hostMaxWidth as number)
    : VIEW_SIDEBAR_MAX_WIDTH;
  const maxWidth = Math.max(VIEW_SIDEBAR_MIN_WIDTH, requestedMax);
  return { minWidth: Math.min(requestedMin, maxWidth), maxWidth };
}

/**
 * Resolves the canonical sidebar preference for a dashboard view.
 *
 * A provider synchronizes all consumers for one project. Standalone stories and tests
 * receive an isolated in-memory controller, so rendering a primitive can never create a
 * raw global storage key.
 */
export function useViewSidebarWidth(options: UseViewSidebarWidthOptions = {}): ViewSidebarWidthController {
  const shared = useContext(ViewLayoutContext);
  const [localWidth, setLocalWidth] = useState(VIEW_SIDEBAR_DEFAULT_WIDTH);
  const bounds = useMemo(
    () => resolveHostBounds(options),
    [options.hostMaxWidth, options.hostMinWidth],
  );
  const preferredWidth = shared?.preferredSidebarWidth ?? localWidth;
  const width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, preferredWidth));

  const previewWidth = useCallback((nextWidth: number) => {
    const next = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, clampViewSidebarWidth(nextWidth)));
    if (shared) return shared.previewSidebarWidth(next);
    setLocalWidth(next);
    return next;
  }, [bounds.maxWidth, bounds.minWidth, shared]);

  const commitWidth = useCallback((nextWidth: number) => {
    const next = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, clampViewSidebarWidth(nextWidth)));
    if (shared) return shared.commitSidebarWidth(next);
    setLocalWidth(next);
    return next;
  }, [bounds.maxWidth, bounds.minWidth, shared]);

  return {
    width,
    preferredWidth,
    minWidth: bounds.minWidth,
    maxWidth: bounds.maxWidth,
    scopeIdentity: shared?.scopeIdentity ?? "standalone",
    projectId: shared?.projectId,
    previewWidth,
    commitWidth,
  };
}
