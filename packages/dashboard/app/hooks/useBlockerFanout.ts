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

/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:20:
THE WRAPPER DROPPED EVERY LANE OPTION, so the card fan-out badges read legacy ids on a renamed board.

`computeBlockerFanoutMap` in core accepts four lane options; this wrapper declared and forwarded only
`staleHighFanoutAgeThresholdMs`, so core fell back to `LEGACY_TERMINAL_COLUMNS`, `holdColumn: "todo"`
and `BLOCKER_ESCALATION_COLUMNS` for every dashboard caller. On a board whose lanes are renamed:

- `activeTodoCount` counts cards in a lane called `todo`, which no longer exists -> the "blocking N"
  badge undercounts, usually to zero;
- terminal detection misses the renamed complete lane, so finished blockers still read as active;
- `shouldEscalate` is false for every blocker, so a stale blocker holding up many cards NEVER
  escalates. Core's own note calls this the worse half: no escalation looks exactly like nothing
  needing escalation.

PER-TASK CLASSIFIERS, NOT COLUMN SETS. Core documents `classify`/`escalationClassify` as "the only
correct option on a multi-workflow board" — a column id means something only relative to its OWN
workflow, so any board-wide union marks a shared id with two workflows' roles at once. Passing
resolved SETS here would reproduce the union read this program's learnings doc lists as its fourth
failure shape.

Absent flags degrade byte-identically to the previous defaults, which is what makes this safe for
unconverted boards: the role helpers fall back to `done`/`archived` (terminal), `todo` (hold) and
`in-progress`/`in-review` (escalation) — the exact three sets core used. Verified against
`LEGACY_TERMINAL_COLUMNS`, `holdColumn` and `BLOCKER_ESCALATION_COLUMNS`.
*/
export interface UseBlockerFanoutOptions {
  staleHighFanoutAgeThresholdMs?: number;
  classify?: (task: Task) => { isHold: boolean; isTerminal: boolean };
  escalationClassify?: (task: Task) => boolean;
}

export function computeBlockerFanoutMap(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  return computeBlockerFanoutMapCore(tasks, MAX_AUTO_MERGE_RETRIES, {
    staleHighFanoutAgeThresholdMs: options.staleHighFanoutAgeThresholdMs,
    classify: options.classify,
    escalationClassify: options.escalationClassify,
  });
}

export function useBlockerFanout(
  tasks: Task[],
  options: UseBlockerFanoutOptions = {},
): Map<string, BlockerFanoutEntry> {
  /* This repo has no `react-hooks/exhaustive-deps` rule, so the classifier deps are listed by hand:
     omitting them would pin the first render's lane vocabulary for the life of the board. */
  return useMemo(
    () => computeBlockerFanoutMap(tasks, options),
    [tasks, options.staleHighFanoutAgeThresholdMs, options.classify, options.escalationClassify],
  );
}
