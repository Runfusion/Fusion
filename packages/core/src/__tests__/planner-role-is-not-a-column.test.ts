/*
FNXC:WorkflowLifecycleColumns 2026-07-30-11:10 (Phase C convergence — vocabulary hygiene):

THE INVARIANT: `"triage"` names TWO different things, and only one of them was removed.

  - the planner AGENT ROLE — the engine lane, its prompt templates, its usage-limit
    accounting. Still called `triage`, and nothing in this program renames it.
  - the intake COLUMN on the default lineage — deleted by U11 (#2515), which merged Todo
    into Planning.

WHY IT NEEDS A TEST. The lifecycle-column census greps `=== "triage"`, so every
`role === "triage"` and `agentType === "triage"` matched it and read as an un-migrated column
guard. That is not a cosmetic accounting problem: the obvious "finish the migration" edit is
to rename the role, and renaming it silently breaks prompt-template resolution (the planner
lane falls back to an empty prompt) and usage-limit lane accounting — neither of which fails
loudly. `PLANNER_AGENT_ROLE` makes the two vocabularies distinguishable by grep, and these
cases make the distinction fail loudly if someone collapses them.

The census's error ran in BOTH directions, which is the real lesson: it flagged role
comparisons that were never column guards while MISSING real column guards in executor.ts
whose locals were named `from` and `originColumn`. A census over a shared string is only as
good as its ability to tell the vocabularies apart.
*/
import { describe, expect, it } from "vitest";

import { PLANNER_AGENT_ROLE } from "../types/task-log.js";
import { resolveAgentPrompt } from "../agent-prompts.js";
import { resolveDefaultWorkflowIr } from "../builtin-workflows.js";
import { resolveLifecycleColumns } from "../workflow-lifecycle-traits.js";

describe("the planner ROLE and the deleted intake COLUMN share a name and nothing else", () => {
  it("keeps the planner role named `triage` after U11 removed the column", () => {
    // If a future edit renames the role to match the column vocabulary, this fails FIRST —
    // before the silent prompt-resolution and usage-accounting breakage downstream.
    expect(PLANNER_AGENT_ROLE).toBe("triage");
  });

  it("resolves the planner lane's prompt through that role", () => {
    const prompt = resolveAgentPrompt(PLANNER_AGENT_ROLE);

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("task specification agent");
  });

  it("proves the default workflow no longer declares a column by that name", () => {
    // Both halves of the invariant in one assertion: the role name survives, the column
    // name does not. A test that only checked the role would pass even if U11 were reverted.
    const columns = (resolveDefaultWorkflowIr() as { columns?: Array<{ id?: string }> }).columns ?? [];

    expect(columns.map((c) => c.id)).not.toContain(PLANNER_AGENT_ROLE);
  });

  it("resolves the default lineage's planning lane by TRAIT, not by that name", () => {
    const lifecycle = resolveLifecycleColumns(resolveDefaultWorkflowIr());

    expect(lifecycle).toBeDefined();
    expect(lifecycle?.intake).toBeDefined();
    expect(lifecycle?.intake).not.toBe(PLANNER_AGENT_ROLE);
    // Post-U11 the merged planning column carries intake AND hold, so the two roles resolve
    // to the same column. That collapse is the intended end state, not a degenerate case.
    expect(lifecycle?.hold).toBe(lifecycle?.intake);
  });
});
