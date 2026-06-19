import { useMemo } from "react";
import { type Task } from "@fusion/core";
import {
  computeBlockerFanoutMap as computeBlockerFanoutMapCore,
  type BlockerFanoutEntry,
} from "../../../core/src/blocker-fanout";

export type { BlockerFanoutEntry };

// Keep in sync with packages/engine/src/self-healing.ts default export.
// FNXC:AutoMergeRetries 2026-06-17-04:20: Dashboard fanout copy uses this as a display fallback until task-card surfaces receive live project settings; engine/self-healing decisions use resolveMaxAutoMergeRetries(settings) and are authoritative.
export const MAX_AUTO_MERGE_RETRIES = 3;

export interface UseBlockerFanoutOptions {
  staleHighFanoutAgeThresholdMs?: number;
}

export function computeBlockerFanoutMap(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  return computeBlockerFanoutMapCore(tasks, MAX_AUTO_MERGE_RETRIES, {
    staleHighFanoutAgeThresholdMs: options.staleHighFanoutAgeThresholdMs,
  });
}

export function useBlockerFanout(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  return useMemo(
    () => computeBlockerFanoutMap(tasks, options),
    [tasks, options.staleHighFanoutAgeThresholdMs],
  );
}
