---
"@runfusion/fusion": patch
---

summary: Agents can auto-claim work on boards with renamed columns, and dependencies finished there now count as done.
category: fix
dev: U7 / R3 — unowned drift-review site. `isRunnableAutoClaimCandidate` carried three lifecycle literals: `column === "todo"` gated candidacy (a renamed workflow's candidate set was permanently empty, silently), and `dependency.column === "done" || "archived"` gated dependency satisfaction (a dependency finished in a renamed complete column was never recognised, blocking the dependent forever). Roles are resolved PER TASK because a dependency may sit on a different workflow from the claimant; both callers are async with store access so they resolve for real. Tasks absent from the resolved map keep the legacy ids, so a partially-resolvable board degrades to today's behavior instead of emptying.
