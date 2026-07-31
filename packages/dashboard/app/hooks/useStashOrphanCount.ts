/*
FNXC:StashRecovery 2026-06-24-00:00:
App-level count of orphaned stash-recovery entries, polled every 30s and surfaced as a header/mobile-nav badge. Extracted verbatim from AppInner so the root component no longer owns the polling loop.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

export interface UseStashOrphanCountResult {
  stashOrphanCount: number;
}

const POLL_INTERVAL_MS = 30000;

export function useStashOrphanCount(currentProjectId: string | undefined): UseStashOrphanCountResult {
  const [stashOrphanCount, setStashOrphanCount] = useState(0);

  const contextVersionRef = useRef(0);

  const load = useCallback(async () => {
    const versionAtStart = contextVersionRef.current;
    try {
      const data = await api<{ count: number }>("/stash-recovery/orphans");
      if (contextVersionRef.current === versionAtStart) setStashOrphanCount(data.count ?? 0);
    } catch {
      if (contextVersionRef.current === versionAtStart) setStashOrphanCount(0);
    }
  }, [currentProjectId]);

  useEffect(() => {
    void load();
    return () => {
      contextVersionRef.current += 1;
    };
  }, [load]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:50:
  The 30s stash-orphan badge poll is suspended while the document is hidden. A badge count nobody can see is
  never worth keeping a backgrounded mobile tab awake — background network work is a primary OS discard
  signal and produced the white-splash reload on return. The badge re-counts once when the tab is shown again.
  */
  useVisibilityAwarePoll(load, POLL_INTERVAL_MS);

  return { stashOrphanCount };
}
