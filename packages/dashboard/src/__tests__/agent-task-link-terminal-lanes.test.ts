/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:00 (dashboard-server feed):

THE INVARIANT: the agent "working on" sanitizer asks each linked task's OWN terminal lanes.

`sanitizeAgentTaskLinks` drops `taskId` from an agent response when the linked task is finished, so
the UI stops showing a stale "working on" indicator. It tested hard-coded terminal ids
— CENSUS-INVISIBLE, because a Set literal is a definition rather than a comparison, so nothing in the
lifecycle backlog pointed at this file. On a renamed board it matched nothing and a FINISHED card kept
its agent's indicator lit: the agent list advertised work that had already shipped, which is exactly
what this sanitizer exists to prevent.

WHY THIS GUARD IS STRUCTURAL AND NOT BEHAVIOURAL, stated plainly rather than dressed up:
`sanitizeAgentTaskLinks` is a closure inside `createApiRoutes`, reachable only by building the full
express app and driving `GET /api/agents` through it. That harness exists (see
`routes-automation.test.ts`) but standing it up to re-assert a per-task resolver is a large amount of
machinery around a small seam, and I did not write it. So this asserts the SOURCE: the resolver is
threaded per task and the bare literal call is gone.

It fails on revert — verified by reverting — which is the bar. It is not a substitute for a
behavioural test, and whoever owns the dashboard server should add one through the express harness if
this seam grows. Flagging that rather than letting a structural check read as full coverage.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");

describe("agent task-link sanitizer resolves each task's own terminal lanes", () => {
  it("resolves the workflow IR per linked task id", () => {
    expect(source).toContain("resolveWorkflowIrForTask(scopedStore, taskId, terminalIrCache");
  });

  it("uses EVERY Complete column, not only the first", () => {
    /*
    #2787 review (greptile P1). The first version resolved `lifecycle.complete`, which is
    FIRST-per-role: a workflow declaring two Complete lanes had only one recognised, so a
    task in the second kept its taskId and the agent stayed shown as working on finished work — the
    exact symptom this sanitizer removes, one degree narrower.
    */
    expect(source).toContain('const terminal = columnsWithFlag(ir, "complete");');
  });

  it("passes the resolved answer into the terminal check", () => {
    expect(source).toContain("isTerminalTaskStatus(taskStatus, terminalByTaskId.get(agent.taskId))");
    // The bare one-argument call is what the conversion removes; its return would be the literal.
    expect(source).not.toContain("isTerminalTaskStatus(taskStatus)");
  });

  it("shares ONE IR cache across the batch rather than resolving per agent", () => {
    // A page of agents may link many tasks across a few workflows; the cache is what keeps this
    // from becoming an IR read per row.
    expect(source).toContain("const terminalIrCache = new Map");
  });

  it("keeps Done as the documented unresolvable-workflow fallback", () => {
    // Removing it would make an unresolvable task read as non-terminal forever, which is a
    // regression in the opposite direction — the indicator would never clear.
    expect(source).toContain('const TERMINAL_TASK_STATUSES = new Set(["done"])');
    expect(source).toContain("resolvedTerminal ?? TERMINAL_TASK_STATUSES");
  });
});
