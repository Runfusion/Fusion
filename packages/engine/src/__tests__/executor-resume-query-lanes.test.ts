/*
FNXC:WorkflowLifecycleColumns 2026-08-01-01:10:

THE INVARIANT: both resume sweeps read the board's OWN wip lane.

THE QUERY, not a comparison. `executor.ts` had already been driven to a low comparison count, and
these two reads were still keyed on `"in-progress"` by name. `listTasks`' `column` option filters in
the STORE, so on a renamed board both returned an EMPTY array and neither resume ran:

  - `resumeTaskForAgent` — a durable agent coming back up adopted nothing, leaving its in-flight task
    orphaned;
  - `resumeOrphaned` — the engine-wide sweep found no orphans to re-dispatch after a restart.

Both are RECOVERY paths, which is the expensive place to be silently inert: the failure surfaces only
after a crash or restart, when the operator is already looking at something else and has every reason
to blame the crash rather than the recovery.

WHY A SEPARATE FILE: the sibling `executor-resume-lanes-resolved.test.ts` mocks `node:fs`, so a source
read there fails with "No readFileSync export is defined on the node:fs mock" — a module mock in one
file is not a property of the module under test, and splitting is cheaper than partial-mocking around it.

STRUCTURAL, and labelled. Driving `resumeOrphaned` end to end needs a live agent registry, worktree
probing and dispatch; the three suites that already exercise it (`restart.integration`,
`executor-soft-delete-guard`, `executor-prompt` — 153 cases) cover the BEHAVIOUR and all stay green.
What was missing is that the read asks for resolved lanes at all, and that is what this pins.

REVERT PROOF, measured: restore either literal read and this fails.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
FNXC:CodeOrganization 2026-08-03-09:55:
resumeTaskForAgent peeled into executor/resume-task-for-agent.ts (U4). The structural
count must include the free module so both resume sweeps still pin listWipLaneTasks.
*/
/*
FNXC:CodeOrganization 2026-08-03-10:25:
listWipLaneTasks body also peeled to executor/list-wip-lane-tasks.ts; role resolution lives there.
*/
const source = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");
const resumeTaskForAgentSource = readFileSync(
  new URL("../executor/resume-task-for-agent.ts", import.meta.url),
  "utf8",
);
const listWipLaneTasksSource = readFileSync(
  new URL("../executor/list-wip-lane-tasks.ts", import.meta.url),
  "utf8",
);
const resumeOrphanedSource = readFileSync(
  new URL("../executor/resume-orphaned.ts", import.meta.url),
  "utf8",
);
const combined = `${source}\n${resumeTaskForAgentSource}\n${listWipLaneTasksSource}\n${resumeOrphanedSource}`;

describe("the resume sweeps read the resolved wip lane", () => {
  it("resolves project wip columns instead of querying the literal", () => {
    expect(listWipLaneTasksSource).toContain('resolveProjectColumnsForRoles(store, ["countsTowardWip"])');
    expect(combined).not.toContain('listTasks({ slim: true, column: "in-progress" })');
  });

  it("routes BOTH sweeps through the one helper", () => {
    // A second copy of the read is how two sweeps drift apart later.
    // Facade uses this.listWipLaneTasks; free module uses deps.listWipLaneTasks.
    const thisCalls = combined.split("await this.listWipLaneTasks()").length - 1;
    const depsCalls = combined.split("await deps.listWipLaneTasks()").length - 1;
    expect(thisCalls + depsCalls).toBe(2);
  });
});
