import { useCallback, useRef } from "react";
import { pushTrace } from "../utils/dashboardTraceBuffer";

/**
 * FNXC:ProjectScoping 2026-07-15-20:10:
 * Project-scoped hooks capture this monotonically increasing context version
 * before an async request or SSE callback is registered. A changed active
 * project invalidates that work, preventing a late prior-project result from
 * being applied to the current view.
 */
export function useProjectContextGuard(projectId: string | undefined, source: string) {
  const versionRef = useRef(0);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  const projectIdRef = useRef<string | undefined>(projectId);
  projectIdRef.current = projectId;

  if (previousProjectIdRef.current !== projectId) {
    previousProjectIdRef.current = projectId;
    versionRef.current += 1;
  }

  const capture = useCallback(() => {
    const projectIdAtStart = projectIdRef.current;
    const contextVersionAtStart = versionRef.current;
    return {
      projectIdAtStart,
      isStale: () => {
        const stale = versionRef.current !== contextVersionAtStart || projectIdRef.current !== projectIdAtStart;
        if (stale) {
          pushTrace(source, "dropped-stale-event", { projectId: projectIdAtStart });
        }
        return stale;
      },
    };
  }, [source]);

  return { capture };
}
