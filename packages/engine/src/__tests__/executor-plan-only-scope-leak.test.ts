import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { executorLog } from "../logger.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4482",
    title: "Scope leak guard",
    description: "",
    prompt: "## Review Level: 1",
    column: "in-progress",
    worktree: "/repo/.worktrees/swift-falcon",
    branch: "fusion/fn-4482",
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

async function setup(params?: {
  reviewLevel?: number;
  enforcement?: "off" | "warn" | "block";
  scope?: string[];
  scopeOverride?: boolean;
  unstaged?: string[];
  staged?: string[];
  committed?: string[];
  gitFailure?: boolean;
}) {
  const store = createMockStore();
  let task = baseTask({
    prompt: `## Review Level: ${params?.reviewLevel ?? 1}`,
    scopeOverride: params?.scopeOverride,
  });
  let tool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.parseFileScopeFromPrompt.mockResolvedValue(params?.scope ?? ["docs/foo.md"]);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: false,
    worktreeInitCommand: undefined,
    planOnlyScopeLeakEnforcement: params?.enforcement ?? "warn",
  });

  mockedExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/swift-falcon\n");
    if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4482\n");
    if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
    if (cmd.includes("git diff --name-only --cached")) {
      if (params?.gitFailure) throw new Error("git failed");
      return Buffer.from(`${(params?.staged ?? []).join("\n")}\n`);
    }
    if (cmd.includes("git diff --name-only abc123..HEAD")) {
      return Buffer.from(`${(params?.committed ?? []).join("\n")}\n`);
    }
    if (cmd.includes("git diff --name-only")) {
      if (params?.gitFailure) throw new Error("git failed");
      return Buffer.from(`${(params?.unstaged ?? []).join("\n")}\n`);
    }
    return Buffer.from("");
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    tool = customTools.find((t: any) => t.name === "fn_task_done");
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, "/repo");
  await executor.execute(task as any);

  return { store, tool };
}

describe("FN-4482 plan-only scope leak guard", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("allows plan-only completion when edits are in-scope", async () => {
    const { store, tool } = await setup({ unstaged: ["docs/foo.md"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.logEntry.mock.calls.some((call: unknown[]) => String(call[1]).includes("[scope-leak] reviewLevel="))).toBe(false);
  });

  it("warns but allows plan-only off-scope edits in default warn mode", async () => {
    const { store, tool } = await setup({ unstaged: ["packages/core/src/db.ts"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4482",
      expect.stringContaining("[scope-leak] reviewLevel=1 enforcement=warn"),
      undefined,
      undefined,
    );
  });

  it("blocks plan-only off-scope edits when enforcement is block", async () => {
    const { store, tool } = await setup({ enforcement: "block", unstaged: ["packages/core/src/db.ts"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Plan-Only scope-leak guard refused fn_task_done");
    expect(result.content[0].text).toContain("packages/core/src/db.ts");
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4482", "in-review");
  });

  it("bypasses guard when scopeOverride=true", async () => {
    const { store, tool } = await setup({ scopeOverride: true, unstaged: ["packages/core/src/db.ts"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4482",
      "[scope-leak] scope guard bypassed via task.scopeOverride",
      undefined,
      undefined,
    );
  });

  it("skips checks when planOnlyScopeLeakEnforcement=off", async () => {
    const { store, tool } = await setup({ enforcement: "off", unstaged: ["packages/core/src/db.ts"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.logEntry.mock.calls.some((call: unknown[]) => String(call[1]).includes("[scope-leak] reviewLevel="))).toBe(false);
  });

  it.each([0, 2])("uses warn-only behavior for non-plan-only review level %s", async (reviewLevel) => {
    const { store, tool } = await setup({ reviewLevel, enforcement: "block", unstaged: ["packages/core/src/db.ts"] });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4482",
      expect.stringContaining(`[scope-leak] reviewLevel=${reviewLevel} enforcement=warn`),
      undefined,
      undefined,
    );
  });

  it("fails open on git capture failure", async () => {
    const { store, tool } = await setup({ gitFailure: true });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("Task marked complete");
    expect((executorLog.warn as any).mock.calls.some(([message]: [string]) => message.includes("Failed to capture uncommitted modified files"))).toBe(true);
    expect(store.logEntry.mock.calls.some((call: unknown[]) => String(call[1]).includes("[scope-leak] reviewLevel="))).toBe(false);
  });
});
