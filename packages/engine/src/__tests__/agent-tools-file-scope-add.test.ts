import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createTaskFileScopeAddTool } from "../agent-tools.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>());
});

const TASK_ID = "FN-4242";

const PROMPT_WITH_SCOPE = `## Mission
Do the thing.

## File Scope
- \`packages/engine/src/existing.ts\`

## Steps
1. Go.
`;

function createMockStore(prompt: string) {
  const getTask = vi.fn<TaskStore["getTask"]>().mockResolvedValue({ id: TASK_ID, prompt } as any);
  const updateTask = vi.fn<TaskStore["updateTask"]>().mockResolvedValue(undefined as any);
  const appendAgentLog = vi.fn<TaskStore["appendAgentLog"]>().mockResolvedValue(undefined);
  const store = { getTask, updateTask, appendAgentLog } as unknown as TaskStore;
  return { store, getTask, updateTask, appendAgentLog };
}

async function runTool(tool: { execute: (...args: any[]) => Promise<any> }, params: Record<string, unknown>) {
  return tool.execute("call-1", params, undefined as any, undefined as any, undefined as any);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

describe("fn_task_file_scope_add", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends new valid files to the ## File Scope section and persists via updateTask", async () => {
    const { store, updateTask, appendAgentLog } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts"], reason: "needed for the fix" });

    expect(updateTask).toHaveBeenCalledTimes(1);
    const [, updates] = updateTask.mock.calls[0];
    const newPrompt = (updates as { prompt: string }).prompt;
    // Both the original and the new entry are present, and the new one is inside File Scope.
    expect(newPrompt).toContain("`packages/engine/src/existing.ts`");
    expect(newPrompt).toContain("`packages/engine/src/foo.ts`");
    // Appended into the File Scope section, not after ## Steps.
    const scopeIdx = newPrompt.indexOf("## File Scope");
    const stepsIdx = newPrompt.indexOf("## Steps");
    expect(newPrompt.indexOf("`packages/engine/src/foo.ts`")).toBeGreaterThan(scopeIdx);
    expect(newPrompt.indexOf("`packages/engine/src/foo.ts`")).toBeLessThan(stepsIdx);
    expect(appendAgentLog).toHaveBeenCalledTimes(1);
    expect(getText(result)).toMatch(/Added to File Scope/);
  });

  it("does not duplicate an entry already in scope and does not call updateTask when nothing new", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/existing.ts"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/Already present/);
  });

  it("rejects invalid entries (path traversal / leading slash) and reports them", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["../secrets.txt", "/etc/passwd"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/Rejected/);
  });

  it("adds valid files while rejecting invalid ones in the same call", async () => {
    const { store, updateTask } = createMockStore(PROMPT_WITH_SCOPE);
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts", "../bad"] });

    expect(updateTask).toHaveBeenCalledTimes(1);
    const text = getText(result);
    expect(text).toMatch(/Added to File Scope: packages\/engine\/src\/foo\.ts/);
    expect(text).toMatch(/Rejected.*\.\.\/bad/);
  });

  it("errors without mutating when PROMPT.md has no ## File Scope section", async () => {
    const { store, updateTask } = createMockStore("## Mission\nDo it.\n\n## Steps\n1. Go.\n");
    const tool = createTaskFileScopeAddTool(store, TASK_ID);

    const result = await runTool(tool, { files: ["packages/engine/src/foo.ts"] });

    expect(updateTask).not.toHaveBeenCalled();
    expect(getText(result)).toMatch(/no "## File Scope" section/);
  });
});
