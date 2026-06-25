/*
FNXC:StashRecovery 2026-06-24-00:00:
App-level count of orphaned stash-recovery entries, polled every 30s and surfaced as a header/mobile-nav badge. Extracted verbatim from AppInner so the root component no longer owns the polling loop.
*/

import { useEffect, useState } from "react";
import { api } from "../api";

export interface UseStashOrphanCountResult {
  stashOrphanCount: number;
}

const POLL_INTERVAL_MS = 30000;

export function useStashOrphanCount(currentProjectId: string | undefined): UseStashOrphanCountResult {
  const [stashOrphanCount, setStashOrphanCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ count: number }>("/stash-recovery/orphans");
        if (!cancelled) setStashOrphanCount(data.count ?? 0);
      } catch {
        if (!cancelled) setStashOrphanCount(0);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentProjectId]);

  return { stashOrphanCount };
}
