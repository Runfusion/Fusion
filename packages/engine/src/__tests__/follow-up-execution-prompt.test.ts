// -nocheck
/*
FNXC:TaskFollowUp 2026-09-17-16:10:
FN-513 Step 4 — the executor-side half. A follow-up was specified against what its source PLANNED,
so its executor must re-read the source and check those inherited assumptions against the code that
is actually present before implementing.

The instruction is deliberately narrow and changes NO gate: whether the task may run at all is still
owned by the scheduler and the dependency dispatch gate. These cases pin both halves — the added
instruction, and the absence of any promise that the source has merged.
*/
import { describe, expect, it } from "vitest";
import "./executor-test-helpers.js";
import { buildExecutionPrompt } from "../executor.js";
import type { TaskDetail } from "@fusion/core";

const FOLLOW_UP_MARKER = { followUp: { version: 1 } };

function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-B",
    title: "Add a CSV export",
    description: "Add a CSV export for the imported rows",
    column: "in-progress",
    dependencies: ["FN-A"],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# FN-B\n\n## Steps\n\n### Step 0: Preflight\n- [ ] check",
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    ...overrides,
  } as TaskDetail;
}

function followUpDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return taskDetail({
    sourceType: "task_refine",
    sourceParentTaskId: "FN-A",
    sourceMetadata: FOLLOW_UP_MARKER,
    ...overrides,
  } as Partial<TaskDetail>);
}

describe("buildExecutionPrompt for a follow-up task", () => {
  it("tells the executor to re-read the source and confirm inherited assumptions against real code", () => {
    const prompt = buildExecutionPrompt(followUpDetail(), "/home/user/project");

    expect(prompt).toContain("## Follow-up source");
    expect(prompt).toContain("follow-up of **FN-A**");
    expect(prompt).toContain("fn_task_show FN-A");
    expect(prompt).toContain("code ACTUALLY PRESENT in this worktree");
    expect(prompt).toContain("may not have been delivered");
    expect(prompt).toContain("do not re-implement FN-A's own work");
  });

  /*
  A source in review can already release a dependent under the existing workflow, so promising the
  operator (or the agent) that the source has merged would be false in the common case.
  */
  it("promises no merge, no wait, and no permission to modify the source", () => {
    const prompt = buildExecutionPrompt(followUpDetail(), "/home/user/project");
    expect(prompt).not.toContain("has been merged");
    expect(prompt).not.toContain("wait until FN-A");
    expect(prompt).toContain("do not modify it");
  });

  it.each([
    ["an ordinary task", taskDetail()],
    ["an ordinary refinement (no marker)", taskDetail({ sourceType: "task_refine", sourceParentTaskId: "FN-A" } as Partial<TaskDetail>)],
    ["an unknown marker version", taskDetail({
      sourceType: "task_refine",
      sourceParentTaskId: "FN-A",
      sourceMetadata: { followUp: { version: 2 } },
    } as Partial<TaskDetail>)],
    ["a duplicate", taskDetail({
      sourceType: "task_duplicate",
      sourceParentTaskId: "FN-A",
      sourceMetadata: FOLLOW_UP_MARKER,
    } as Partial<TaskDetail>)],
    ["a marker with no parent id", taskDetail({ sourceType: "task_refine", sourceMetadata: FOLLOW_UP_MARKER } as Partial<TaskDetail>)],
  ])("adds nothing for %s", (_label, detail) => {
    const prompt = buildExecutionPrompt(detail, "/home/user/project");
    expect(prompt).not.toContain("## Follow-up source");
    expect(prompt).not.toContain("follow-up of **");
  });

  it("keeps the existing prompt structure intact around the added section", () => {
    const prompt = buildExecutionPrompt(followUpDetail(), "/home/user/project");
    expect(prompt).toContain("## PROMPT.md");
    expect(prompt).toContain("## Review level:");
    // The source note sits after the spec body and before the review-level contract.
    expect(prompt.indexOf("## PROMPT.md")).toBeLessThan(prompt.indexOf("## Follow-up source"));
    expect(prompt.indexOf("## Follow-up source")).toBeLessThan(prompt.indexOf("## Review level:"));
  });
});
