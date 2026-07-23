import { describe, expect, it, vi } from "vitest";
import { type TaskStore } from "@fusion/core";
import { PLANNING_SYSTEM_PROMPT, resolvePlanningModeSystemPrompt } from "../planning.js";

function store(settings: Record<string, unknown> = {}, workflowPrompt?: string): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    getWorkflowDefinition: vi.fn().mockResolvedValue(workflowPrompt ? {
      ir: { version: 1, nodes: [{ id: "plan", kind: "prompt", config: { seam: "planning", prompt: workflowPrompt } }], edges: [], columns: [] },
    } : undefined),
  } as unknown as TaskStore;
}

describe("resolvePlanningModeSystemPrompt", () => {
  it("uses only the dedicated planning prompt for custom and built-in workflows", async () => {
    const executionMarkers = "PROMPT.md NO-CODE TASK CAVEAT CREATE CHILD TASK";
    const customWorkflow = await resolvePlanningModeSystemPrompt(store({}, executionMarkers), undefined, "WF-custom");
    const builtInWorkflow = await resolvePlanningModeSystemPrompt(store({}, executionMarkers), undefined, "builtin:coding");

    expect(customWorkflow).toBe(PLANNING_SYSTEM_PROMPT);
    expect(builtInWorkflow).toBe(PLANNING_SYSTEM_PROMPT);
    expect(customWorkflow).not.toContain(executionMarkers);
    expect(builtInWorkflow).not.toContain(executionMarkers);
  });

  it("cannot inherit execution-only markers from an assigned triage prompt", async () => {
    const prompt = await resolvePlanningModeSystemPrompt(store({
      agentPrompts: {
        roleAssignments: { triage: "custom-triage" },
        templates: [{ id: "custom-triage", role: "triage", prompt: "TRIAGE PROMPT.md NO-CODE CREATE CHILD TASK" }],
      },
    }));

    expect(prompt).toBe(PLANNING_SYSTEM_PROMPT);
    expect(prompt).not.toMatch(/TRIAGE PROMPT\.md NO-CODE CREATE CHILD TASK/);
    expect(prompt).toContain('"type":"question"');
    expect(prompt).toContain("Only the user can validate");
  });

  it("lets a nonblank planning-system override replace the full prompt", async () => {
    await expect(resolvePlanningModeSystemPrompt(store(), { "planning-system": "OPERATOR REPLACEMENT" }))
      .resolves.toBe("OPERATOR REPLACEMENT");
  });

  it("uses the dedicated prompt for absent or blank overrides and when settings fail", async () => {
    await expect(resolvePlanningModeSystemPrompt(store())).resolves.toBe(PLANNING_SYSTEM_PROMPT);
    await expect(resolvePlanningModeSystemPrompt(store({ promptOverrides: { "planning-system": "   " } }))).resolves.toBe(PLANNING_SYSTEM_PROMPT);
    await expect(resolvePlanningModeSystemPrompt({ getSettings: vi.fn().mockRejectedValue(new Error("broken")) } as unknown as TaskStore))
      .resolves.toBe(PLANNING_SYSTEM_PROMPT);
  });
});
