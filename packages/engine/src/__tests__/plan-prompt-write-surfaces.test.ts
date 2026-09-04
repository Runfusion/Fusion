import { readFile } from "node:fs/promises";

import { type RunMutationContext, type TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { createTaskPromptWriteTool as createTriagePromptWriteTool } from "../agent-tools.js";
import { createTaskPromptWriteTool as createPlanReviewPromptWriteTool } from "../executor/shared-worker-tools.js";

const TASK_ID = "FN-142";
const CONTENT = "# Verified plan";

async function runTool(tool: { execute: (...args: any[]) => Promise<any> }) {
  return tool.execute("call-prompt", { content: CONTENT }, undefined, undefined, undefined);
}

function getText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

function createProductionShapedStore() {
  const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID });
  const getTask = vi.fn().mockResolvedValue({ id: TASK_ID, prompt: CONTENT });
  return {
    store: { updateTask, getTask } as unknown as TaskStore,
    updateTask,
    getTask,
  };
}

describe("planning prompt-write surfaces", () => {
  /*
  FNXC:PlanArtifactPersistence 2026-08-22-03:37:
  Initial planning, replanning, Plan Review repair, and reviewer inline repair must all retain the
  same fail-closed PROMPT.md read-back. Their task-row mutation result intentionally has no prompt.
  */
  it("confirms initial triage and replanning writes through the production factory with its run context", async () => {
    const { store, updateTask } = createProductionShapedStore();
    const runContext = { agentId: "triage-agent", runId: "run-142" } as RunMutationContext;

    const result = await runTool(createTriagePromptWriteTool(store, TASK_ID, runContext));

    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { prompt: CONTENT }, runContext);
    expect(getText(result)).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  it("confirms Plan Review repair writes through the shared worker registration", async () => {
    const { store, updateTask } = createProductionShapedStore();
    const runContext = { agentId: "review-agent", runId: "run-143" } as RunMutationContext;
    const deps = { store, getRunContextFor: vi.fn().mockReturnValue(runContext) } as any;

    const result = await runTool(createPlanReviewPromptWriteTool(deps, TASK_ID));

    expect(deps.getRunContextFor).toHaveBeenCalledWith(TASK_ID);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { prompt: CONTENT }, runContext);
    expect(getText(result)).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  it("keeps reviewer inline repair wired to the same production prompt-write factory", async () => {
    const reviewerSource = await readFile(new URL("../execution/reviewer.ts", import.meta.url), "utf8");
    const { store } = createProductionShapedStore();

    expect(reviewerSource).toContain("createTaskPromptWriteTool(options.store, options.taskId)");
    expect(getText(await runTool(createTriagePromptWriteTool(store, TASK_ID)))).toBe(`Updated PROMPT.md for ${TASK_ID}.`);
  });

  it("never treats a promptless updateTask row as verification evidence", async () => {
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID });
    const getTask = vi.fn().mockResolvedValue(null);
    const store = { updateTask, getTask } as unknown as TaskStore;

    const result = await runTool(createTriagePromptWriteTool(store, TASK_ID));

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(getText(result)).toContain("could not be verified");
  });
});
