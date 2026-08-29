export type IngestedCheckStateValue = "success" | "pending" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | "stale" | "startup_failure" | string;
export interface IngestedCheckState { repo: string; headSha: string; checkName: string; state: IngestedCheckStateValue; reportedAt: string; detailsUrl?: string; }
export interface MergeablePrCheck { name: string; required: boolean; state: IngestedCheckStateValue; detailsUrl?: string; startedAt?: string; completedAt?: string; }
const satisfying = (state: string) => state === "success" || state === "neutral" || state === "skipped";
const terminal = (state: string) => state !== "pending";

/*
FNXC:PrMergeEventDrivenChecks 2026-08-09-14:35:
Only required, same-project resolver results for the exact PR head may fill polling gaps. An absent
head is never a wildcard, and any disagreement retains the non-satisfying state to fail closed.
*/
export function mergeIngestedCheckStates<T extends MergeablePrCheck>(input: {
  polled: T[]; ingested: IngestedCheckState[]; requiredCheckNames: string[]; repo: string; headSha?: string;
}): { checks: T[]; appliedNames: Set<string> } {
  if (input.requiredCheckNames.length === 0 || !input.headSha?.trim()) return { checks: input.polled, appliedNames: new Set() };
  const required = new Set(input.requiredCheckNames);
  const repo = input.repo.trim().toLowerCase();
  const sha = input.headSha.trim().toLowerCase();
  const candidates = input.ingested.filter((check) => required.has(check.checkName) && check.repo.trim().toLowerCase() === repo && check.headSha.trim().toLowerCase() === sha);
  const result = [...input.polled];
  const appliedNames = new Set<string>();
  for (const incoming of candidates) {
    const index = result.findIndex((check) => check.name === incoming.checkName);
    const existing = index < 0 ? undefined : result[index];
    if (existing && terminal(existing.state) && !satisfying(existing.state)) continue;
    if (existing && terminal(existing.state) && satisfying(existing.state) && satisfying(incoming.state)) continue;
    const next = { name: incoming.checkName, required: true, state: incoming.state, detailsUrl: incoming.detailsUrl } as T;
    if (index < 0) result.push(next); else result[index] = next;
    appliedNames.add(incoming.checkName);
  }
  return { checks: result, appliedNames };
}
