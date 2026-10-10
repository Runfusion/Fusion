/**
 * The `[timing]` log-entry rule that produces a task's `timedExecutionMs`.
 *
 * FNXC:TaskLogProjections 2026-10-10-20:55 (RUFU-615):
 * This rule was RUFU-542's `computeTimedExecutionMs` inside `task-store/serialization.ts`, and RUFU-615
 * moved it here because the write-time projection needs it too — and a projection module that imports
 * the serialization module is not a browser leaf. `tasks/in-review-stall.ts` is reachable from the
 * dashboard's browser bundle through `types.ts -> settings-scope -> settings-schema`, so the moment
 * `task-log-projections.ts` pulled in `serialization.ts` (which imports `node:crypto` for document
 * preconditions), `vite build` failed with `"createHash" is not exported by "__v-browser-external"`.
 * The leaf it lands in must therefore import nothing but types: this file is pure over log entries.
 *
 * Behaviour is verbatim, including the quirks that the projection column deliberately inherits: the
 * sum is fractional milliseconds, so `tasks.timing_total_ms` is `double precision` and not `bigint`.
 */

import type { TaskLogEntry } from "../types.js";

/** Sum of every `N ms` figure carried by a `[timing]`-tagged log entry. Absent or empty log yields 0. */
export function computeTimedExecutionMs(log: TaskLogEntry[] | undefined): number {
  if (!log || log.length === 0) return 0;
  let total = 0;
  for (const entry of log) {
    const action = typeof entry.action === "string" ? entry.action : "";
    const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
    if (!action.includes("[timing]") && !outcome.includes("[timing]")) continue;
    const haystack = `${action}\n${outcome}`;
    const match = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
    if (!match) continue;
    const ms = Number(match[1]);
    if (Number.isFinite(ms)) total += ms;
  }
  return total;
}
