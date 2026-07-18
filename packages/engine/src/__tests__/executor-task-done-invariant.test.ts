import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import * as worktreePool from "../worktree-pool.js";
import { type TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createMockStore, mockedCreateFnAgent, mockedExec, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

const fn416Prompt = `# Task: FN-416 - Assign ready implementation task to active owner

**Created:** 2026-06-12
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is an operational routing task with no expected product-source changes.

## Mission
Assign or route exactly one ready implementation task to an eligible active owner, or record an intentional no-route state. No source files expected.

## File Scope

- FN-416 task document docs via fn_task_document_write
- .fusion/tasks/FN-416/ task log evidence only

## Steps

### Step 0: Preflight
- [x] Check board state

### Step 1: Route exactly one existing ready task or record no-route
- [x] Record evidence in task documents/logs
`;

const sourceChangingPlanOnlyPrompt = `# Task: FN-999 - Implement source fix

**Size:** S

## Review Level: 1 (Plan Only)

## Mission
Implement a source-changing bug-fix in the executor.

## File Scope

- packages/engine/src/executor.ts

## Steps

### Step 1: Implement
- [ ] Change source
`;

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4114",
    title: "Invariant test",
    description: "",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4114",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  let task: any = baseTask(overrides);
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.moveTask.mockImplementation(async (id: string, column: string) => {
    task = { ...task, id, column, paused: false, pausedByAgentId: null, status: null, error: null };
  });
  store.handoffToReview.mockImplementation(async (id: string) => {
    task = { ...task, id, column: "in-review", paused: false, pausedByAgentId: null };
    return task;
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((t: any) => t.name === "fn_task_done");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(task as any);

  return { store, tool, setTask: (next: any) => (task = { ...task, ...next }) };
}

describe("FN-4114 fn_task_done invariants", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
  });

  it("FN-4114 refuses fn_task_done when toplevel resolves to repo root", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_toplevel");
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 refuses fn_task_done when branch is wrong", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 refuses fn_task_done when no commits exist beyond base", async () => {
    const { store, tool } = await setup();
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it.each([
    "NO-OP: existing tests already cover this",
    "PREMISE STALE: targeted reproduction already passes unchanged on HEAD",
    "DUPLICATE: FN-6239 existing QuickChatFAB tests already cover this",
  ])("FN-6275 allows verified no-op zero-commit completion with sentinel %s", async (summary) => {
    const { store, tool } = await setup({
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Implement", status: "skipped" as const },
        { name: "Testing & Verification", status: "done" as const },
      ],
      currentStep: 2,
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary });

    expect(result.content[0].text).toContain("Task marked complete");
    expect(result.content[0].text).not.toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-4114", { noCommitsExpected: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4114",
      expect.stringContaining("completion sentinel accepted"),
      expect.stringContaining(summary),
      undefined,
    );
    expect(store.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:updated",
      taskId: "FN-4114",
      metadata: expect.objectContaining({ summary }),
    }));
  });

  it("FN-6275 still refuses ordinary zero-commit completion summaries", async () => {
    const { store, tool } = await setup({
      steps: [{ name: "Implement", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary: "Verified existing behavior with targeted tests." });

    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4114", { noCommitsExpected: true });
  });

  it.each([
    ["wrong_toplevel", "/repo\n", "fusion/fn-4114\n"],
    ["wrong_branch", "/repo/.worktrees/swift-falcon\n", "main\n"],
  ] as const)("FN-6275 does not relax %s for sentinel summaries", async (reason, toplevel, branch) => {
    const { store, tool } = await setup({ steps: [{ name: "Implement", status: "done" as const }] });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(toplevel);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from(branch);
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary: "NO-OP: already covered" });

    expect(result.content[0].text).toContain(`fn_task_done refused: ${reason}`);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4114", { noCommitsExpected: true });
  });

  it("FN-6275 sentinel summaries do not auto-complete multiple pending unreviewed steps", async () => {
    const { store, tool } = await setup({
      steps: [
        { name: "Implement", status: "in-progress" as const },
        { name: "Testing", status: "pending" as const },
      ],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary: "NO-OP: already covered" });

    expect(result.content[0].text).toContain("fn_task_done refused (bulk-step-completion-without-review)");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-350 allows Review Level 1 coordination completion with zero commits when no source files are scoped", async () => {
    const fn350Prompt = `# Task: FN-350 - Route Ready Swift Tasks to Executor Owner

**Created:** 2026-06-12
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** This is a coordination/routing task that should not change product source, but it can affect execution ordering and owner assignment for active Swift implementation work. Risk is low if the executor follows the existing coordinator handoff policy, routes at most one existing ready task, and records clear evidence instead of creating duplicate implementation work.

## Mission

Route exactly one existing ready Swift implementation task to the durable executor owner, or record the intentional block if no safe candidate exists. Do not change product source.

## File Scope

Atlas Notes task-board artifacts only:

- FN-350 task document \`docs\` via \`fn_task_document_write\`
- Board task metadata and logs via Fusion task tools

## Steps

### Step 0: Preflight
- [x] Required board records exist.

### Step 1: Re-check live candidate readiness
- [x] Candidate readiness inspected.

### Step 2: Select exactly one routing action
- [x] One routing action selected.

### Step 3: Perform safe routing or record intentional block
- [x] Routing evidence recorded.

### Step 4: Testing & Verification
- [x] Board-only verification recorded.

### Step 5: Documentation & Delivery
- [x] Final documentation saved.

## Do NOT

- Do not edit product source.
- Do not create duplicate implementation tasks.
`;
    const { store, tool } = await setup({
      id: "FN-350",
      title: "Route Ready Swift Tasks to Executor Owner",
      description: "Coordination/routing task with task-document evidence only.",
      prompt: fn350Prompt,
      branch: "fusion/fn-350",
      noCommitsExpected: undefined,
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Re-check live candidate readiness", status: "done" as const },
        { name: "Select exactly one routing action", status: "done" as const },
        { name: "Perform safe routing or record intentional block", status: "done" as const },
        { name: "Testing & Verification", status: "done" as const },
        { name: "Documentation & Delivery", status: "in-progress" as const },
      ],
      currentStep: 5,
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-350\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    store.moveTask.mockClear();
    const result = await tool.execute("id", { summary: "Recorded routing evidence in task documents and logs." });

    expect(result.content[0].text).toContain("Task marked complete");
    expect(result.content[0].text).not.toContain("fn_task_done refused: no_commits");
    expect(store.moveTask.mock.calls).toEqual([["FN-350", "in-progress"]]);
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("FN-7487 allows source-free gitignored task-artifact delivery with zero commits", async () => {
    const fn7487Prompt = `# Task: FN-7487 - Audit FN-6902 spec compliance

**Created:** 2026-07-03
**Size:** S

## Review Level: 0 (None)

## Mission

Deliver the requested source-free task-artifact audit. The deliverables are gitignored task artifacts only, not product source changes.

## File Scope

- .fusion/tasks/FN-6902/PROMPT.md
- .fusion/tasks/FN-7487/attachments/fn-6902-spec-compliance.test.mjs

## Steps

### Step 0: Preflight
- [x] Read the source task prompt.

### Step 1: Write source-free task artifact evidence
- [x] Save the audit artifact under .fusion/tasks/.

## Do NOT

- Do not force-add gitignored .fusion/ artifacts.
- Do not create empty commits or fabricate commits for this source-free delivery.
`;
    const { store, tool } = await setup({
      id: "FN-7487",
      title: "Audit FN-6902 spec compliance",
      description: "Source-free task-artifact delivery only.",
      prompt: fn7487Prompt,
      branch: "fusion/fn-7487",
      noCommitsExpected: undefined,
      reviewLevel: 0,
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Write source-free task artifact evidence", status: "done" as const },
      ],
      currentStep: 1,
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-7487\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    store.moveTask.mockClear();
    const result = await tool.execute("id", { summary: "Saved the source-free task-artifact audit and verified the artifact path." });

    expect(result.content[0].text).toContain("Task marked complete");
    expect(result.content[0].text).not.toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-7487", "todo", { preserveProgress: true });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7487",
      expect.stringContaining("prompt-derived source-free task-artifact contract"),
      undefined,
      undefined,
    );
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
  });

  it("FN-7487 refuses mixed task artifacts and tracked source scope with zero commits", async () => {
    const mixedPrompt = `# Task: FN-7487 - Audit and update executor

## Review Level: 0 (None)

## Mission
Deliver source-free task artifacts if possible, but also update tracked documentation.

## File Scope

- .fusion/tasks/FN-6902/PROMPT.md
- .fusion/tasks/FN-7487/attachments/fn-6902-spec-compliance.test.mjs
- docs/testing.md

## Steps

### Step 1: Deliver
- [x] Work completed.

## Do NOT

- Do not force-add gitignored .fusion/ artifacts.
- Do not create empty commits or fabricate commits for this source-free delivery.
`;
    const { store, tool } = await setup({
      id: "FN-7487",
      prompt: mixedPrompt,
      branch: "fusion/fn-7487",
      noCommitsExpected: undefined,
      reviewLevel: 0,
      steps: [{ name: "Deliver", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-7487\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", { summary: "Saved artifacts and documentation." });

    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-7487", "todo", { preserveProgress: true });
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-7487",
      expect.stringContaining("prompt-derived source-free task-artifact contract"),
      undefined,
      undefined,
    );
  });

  it("FN-350 refuses contradictory implementation plus coordination fallback prompts", async () => {
    const prompt = `# Task: FN-350 - Route Ready Swift Tasks to Executor Owner

## Review Level: 1 (Plan Only)

**Assessment:** This is a coordination/routing task that should not change product source.

## Mission
Implement the source fix if possible, or record the intentional block if no safe candidate exists. Do not change product source.

## File Scope

- FN-350 task document \`docs\` via \`fn_task_document_write\`

## Steps

### Step 1: Decide
- [x] Decision recorded.
`;
    const { store, tool } = await setup({
      id: "FN-350",
      title: "Route Ready Swift Tasks to Executor Owner",
      description: "Coordination/routing task with task-document evidence only.",
      prompt,
      branch: "fusion/fn-350",
      noCommitsExpected: undefined,
      steps: [{ name: "Decide", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-350\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});

    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-350", "todo", { preserveProgress: true });
  });

  it("FN-4114 still refuses source-changing implementation tasks with zero commits and no explicit no-commit contract", async () => {
    const implementationPrompt = `# Task: FN-4114 - Implement source change

**Size:** M

## Review Level: 2 (Plan and Code)

## Mission

Implement a bug fix in the engine.

## File Scope

- packages/engine/src/executor.ts
- packages/engine/src/__tests__/executor-task-done-invariant.test.ts

## Steps

### Step 1: Implement
- [ ] Change source code and tests.
`;
    const { store, tool } = await setup({ prompt: implementationPrompt, noCommitsExpected: undefined });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});

    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 allows no-commit completion when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4114",
      expect.stringContaining("noCommitsExpected=true"),
      undefined,
      undefined,
    );
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
  });

  it("FN-4114 still refuses wrong_toplevel even when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_toplevel");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 still refuses wrong_branch even when noCommitsExpected is true", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("main\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: wrong_branch");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });
  it("FN-4114 allows no-commit completion when noCommitsExpected audit logging fails", async () => {
    const { store, tool } = await setup({ noCommitsExpected: true });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    store.logEntry.mockImplementation(async (_id: string, message: string) => {
      if (message.includes("no_commits guard skipped")) throw new Error("audit unavailable");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
  });


  it("FN-416 allows plan-only operational no-source completion with zero commits when the explicit flag is missing", async () => {
    const { store, tool } = await setup({
      id: "FN-416",
      branch: "fusion/fn-416",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: fn416Prompt,
      sourceMetadata: { fileScope: ["FN-416 task document docs via fn_task_document_write"] },
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [
        { name: "Preflight", status: "done" as const },
        { name: "Route or record no-route", status: "done" as const },
      ],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-416\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-416", "todo", { preserveProgress: true });
    expect(store.handoffToReview).not.toHaveBeenCalledWith("FN-416", expect.objectContaining({
      evidence: expect.objectContaining({ reason: "invariant-check-failed" }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-416",
      expect.stringContaining("prompt/source metadata derived operational no-commit contract"),
      undefined,
      undefined,
    );
    const revListCalled = mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes("rev-list --count"));
    expect(revListCalled).toBe(false);
  });
  it("FN-416 refuses plan-only operational no-source completion when File Scope is missing", async () => {
    const promptWithoutFileScope = `# Task: FN-417 - Assign ready implementation task to active owner

## Review Level: 1 (Plan Only)

**Assessment:** This is an operational routing task with no expected product-source changes.

## Mission
Assign or route exactly one ready implementation task to an eligible active owner, or record an intentional no-route state. No source files expected.

## Steps

### Step 1: Route exactly one existing ready task or record no-route
- [x] Record evidence in task documents/logs
`;
    const { store, tool } = await setup({
      id: "FN-417",
      branch: "fusion/fn-417",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: promptWithoutFileScope,
      sourceMetadata: {},
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [{ name: "Route or record no-route", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-417\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-417", "todo", { preserveProgress: true });
  });

  it("FN-416 refuses prompt-only evidence text when steps are incomplete and logs are empty", async () => {
    const { store, tool } = await setup({
      id: "FN-418",
      branch: "fusion/fn-418",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: fn416Prompt.replace("# Task: FN-416", "# Task: FN-418"),
      sourceMetadata: { fileScope: ["FN-418 task document docs via fn_task_document_write"] },
      log: [],
      steps: [{ name: "Route or record no-route", status: "in-progress" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-418\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-418", "todo", { preserveProgress: true });
  });

  it("FN-416 refuses mixed no-source text with source-changing scope entries", async () => {
    const mixedScopePrompt = fn416Prompt
      .replace("# Task: FN-416", "# Task: FN-419")
      .replace(
        "- FN-416 task document docs via fn_task_document_write",
        "- No source changes expected, but inspect packages/engine/src/executor.ts",
      );
    const { store, tool } = await setup({
      id: "FN-419",
      branch: "fusion/fn-419",
      title: "Assign ready implementation task to active owner",
      description: "Operational routing task with no expected product-source changes; record routing evidence or no-route state.",
      reviewLevel: 1,
      prompt: mixedScopePrompt,
      sourceMetadata: { fileScope: ["No source changes expected, but inspect packages/engine/src/executor.ts"] },
      log: [{ timestamp: new Date().toISOString(), action: "Routing evidence recorded", outcome: "No-route state documented in task docs" }],
      steps: [{ name: "Route or record no-route", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-419\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-419", "todo", { preserveProgress: true });
  });

  it("FN-416 keeps the missing-commit guard for source-changing plan-only tasks without an explicit contract", async () => {
    const { store, tool } = await setup({
      title: "Implement executor fix",
      description: "Plan Only but requires source-changing implementation work.",
      reviewLevel: 1,
      prompt: sourceChangingPlanOnlyPrompt,
      sourceMetadata: { fileScope: ["packages/engine/src/executor.ts"] },
      steps: [{ name: "Implement", status: "done" as const }],
    });
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4114\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("0\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });

    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("fn_task_done refused: no_commits");
    expect(store.moveTask).toHaveBeenCalledWith("FN-4114", "todo", { preserveProgress: true });
  });

  it("FN-4114 allows fn_task_done on valid worktree/branch/commit state", async () => {
    const { store, tool } = await setup();
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.updateStep).toHaveBeenCalled();
  });
});

/* FNXC:PgMigrationQuarantine 2026-07-18-01:20: FN-8258 runs handoff-audit invariants against the PostgreSQL TaskStore and its async audit boundary, replacing the removed SQLite constructor. */
pgDescribe("FN-5241 executor handoff auditing", () => {
  let rootDir: string;
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    // Reset the executor subprocess mock before PG setup so the harness can pass psql through.
    resetExecutorMocks();
    harness = await createTaskStoreForTest({ prefix: "fusion_executor_handoff_audit" });
    rootDir = harness.rootDir;
    store = harness.store;
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  async function createExecutorTask(taskDoneRetryCount = 0) {
    const created = await store.createTask({ description: "Invariant test", priority: "high" });
    await store.moveTask(created.id, "todo");
    await store.moveTask(created.id, "in-progress");
    const worktreePath = join(rootDir, ".worktrees", "swift-falcon");
    mkdirSync(worktreePath, { recursive: true });
    const branch = `fusion/${created.id.toLowerCase()}`;
    await store.updateTask(created.id, {
      worktree: worktreePath,
      branch,
      baseCommitSha: "abc123",
      taskDoneRetryCount,
      steps: [{ name: "Step 1", status: "in-progress" }],
      currentStep: 0,
    });
    const task = (await store.getTask(created.id))!;
    return {
      task: {
        ...task,
        prompt: "# Test\n## Steps\n### Step 1: Implement\n- [ ] check",
      },
      worktreePath,
    };
  }

  /*
  FNXC:WorkflowLifecycle 2026-07-01-22:10:
  workflowGraphExecutor is default-on, so the FN-5241 "atomic in-review handoff seam" auditing was
  superseded by the graph lifecycle:
    - SUCCESSFUL builtin:coding completion reaches in-review via the MERGE-NODE boundary moveTask
      (executor.ts:6106, "handoff-invariant-violation-allowlist: workflow merge node owns the merge
      lifecycle boundary"), NOT the review-seam handoffTaskToReview("workflow-graph-review"). There is no
      longer a task:handoff("workflow-graph-review") event nor a review-seam merge-queue enqueue on this
      path; the merge boundary records task:move audits instead.
    - EXHAUSTION/no-fn_task_done budget now FAILS IN PLACE (executor.ts:2088 "in-review is reserved for
      clean completion handoffs"); the "max-task-done-retries-exhausted" in-review reason no longer exists.
  These tests are migrated to assert the CURRENT mechanisms; they still protect the FN-5241 intent (a clean
  completion reaches in-review; an exhausted no-fn_task_done run is terminal), just via the graph seams.
  */

  it("moves a cleanly completed task to in-review via the merge-node boundary", async () => {
    const { task, worktreePath } = await createExecutorTask();
    // Graph-native implementation proof: the mock agent signals completion via fn_task_done without running
    // the foreach step-execute nodes, so the merge-boundary FN-7260/FN-7271 proof gate needs an explicit
    // node-source pre-merge pass to model a genuinely-implemented task reaching the merge boundary.
    await store.updateTask(task.id, {
      workflowStepResults: [
        { workflowStepId: "execute", workflowStepName: "Execute", phase: "pre-merge", source: "node", status: "passed" },
      ],
    } as any);
    mockedExec.mockImplementation(((cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (!cb) return undefined as any;
      if (cmd.includes("rev-parse --show-toplevel")) return cb(null, `${worktreePath}\n`, "");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return cb(null, `${task.branch}\n`, "");
      if (cmd.includes("rev-list --count")) return cb(null, "1\n", "");
      if (cmd.includes("rev-parse HEAD")) return cb(null, "def456\n", "");
      return cb(null, "", "");
    }) as any);
    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const taskDoneTool = customTools.find((tool: any) => tool.name === "fn_task_done");
          await taskDoneTool.execute("tool-1", {});
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    }) as any);

    const executor = new TaskExecutor(store as any, rootDir);
    // The merge-node boundary requests merge via the injected requester before it inline-merges; returning
    // a non-merged "queued" result keeps the task terminal in-review (autoMerge deferred) instead of
    // finalizing it to done, so we observe the review-staging state under test.
    executor.setMergeRequester(async () => ({ merged: false, noOp: false, reason: "queued" }) as any);
    await executor.execute(task as any);

    // CURRENT completion mechanism: task ends in-review via the merge-node boundary moveTask.
    expect((await store.getTask(task.id))?.column).toBe("in-review");
    // Forensic intent preserved via the mechanism that actually fires now: the merge boundary records a
    // task:move into in-review (the review-seam task:handoff("workflow-graph-review") event and the
    // review-seam merge-queue enqueue no longer occur on this path).
    const moveToReview = (await store
      .getRunAuditEventsAsync({ taskId: task.id, mutationType: "task:move", limit: 20 }))
      .find((event) => (event.metadata as { to?: string })?.to === "in-review");
    expect(moveToReview).toBeDefined();
    expect(await store.getRunAuditEventsAsync({ taskId: task.id, mutationType: "task:handoff", limit: 10 })).toHaveLength(0);
  });

  it("fails a no-fn_task_done retry-budget-exhausted run in place without moving to in-review", async () => {
    const { task, worktreePath } = await createExecutorTask(3);
    mockedExec.mockImplementation(((cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (!cb) return undefined as any;
      if (cmd.includes("rev-parse --show-toplevel")) return cb(null, `${worktreePath}\n`, "");
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return cb(null, `${task.branch}\n`, "");
      if (cmd.includes("rev-list --count")) return cb(null, "1\n", "");
      if (cmd.includes("rev-parse HEAD")) return cb(null, "def456\n", "");
      return cb(null, "", "");
    }) as any);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const executor = new TaskExecutor(store as any, rootDir);
    await executor.execute(task as any);

    const latest = await store.getTask(task.id);
    // A no-fn_task_done run that cannot cleanly complete is NOT a review handoff (executor.ts:2088:
    // "in-review is reserved for clean completion handoffs"). It must never advance to in-review, and the
    // FN-5241 review-seam handoff auditing (task:handoff "workflow-graph-review" /
    // "max-task-done-retries-exhausted") + merge-queue enqueue are superseded — none of them fire here.
    expect(latest?.column).not.toBe("in-review");
    expect(await store.getRunAuditEventsAsync({ taskId: task.id, mutationType: "task:handoff", limit: 10 })).toHaveLength(0);
    expect(await store.peekMergeQueue()).toEqual([]);
  });
});
