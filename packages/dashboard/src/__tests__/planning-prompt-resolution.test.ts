import { describe, expect, it, vi } from "vitest";
import { PROMPT_KEY_CATALOG, type TaskStore } from "@fusion/core";
import { resolvePlanningModeSystemPrompt } from "../planning.js";

function store(settings: Record<string, unknown> = {}, workflowPrompt?: string): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    getWorkflowDefinition: vi.fn().mockResolvedValue(workflowPrompt ? {
      ir: { version: 1, nodes: [{ id: "plan", kind: "prompt", config: { seam: "planning", prompt: workflowPrompt } }], edges: [], columns: [] },
    } : undefined),
  } as unknown as TaskStore;
}

describe("resolvePlanningModeSystemPrompt", () => {
  it("composes the selected workflow planning seam with the interview adapter", async () => {
    const prompt = await resolvePlanningModeSystemPrompt(store({}, "CUSTOM WORKFLOW PLANNING SEAM"), undefined, "WF-custom");
    expect(prompt).toContain("CUSTOM WORKFLOW PLANNING SEAM");
    expect(prompt).toContain('"type":"question"');
    expect(prompt).toContain("exactly one");
    expect(prompt).toContain("Only the user can validate");
  });

  it("does not mistake the catalog fallback for an explicit override", async () => {
    const prompt = await resolvePlanningModeSystemPrompt(store({}, "WORKFLOW SEAM MARKER"), undefined, "WF-custom");
    expect(prompt).toContain("WORKFLOW SEAM MARKER");
    expect(prompt).not.toBe(PROMPT_KEY_CATALOG["planning-system"].defaultContent);
  });

  it("lets an explicit planning-system override replace the full prompt", async () => {
    await expect(resolvePlanningModeSystemPrompt(store(), { "planning-system": "OPERATOR REPLACEMENT" }))
      .resolves.toBe("OPERATOR REPLACEMENT");
  });

  it("prefers the configured triage assignment and fails soft to a builtin seam", async () => {
    const assigned = await resolvePlanningModeSystemPrompt(store({ agentPrompts: { roleAssignments: { triage: "custom-triage" }, templates: [{ id: "custom-triage", role: "triage", prompt: "TRIAGE ASSIGNMENT MARKER" }] } }));
    expect(assigned).toContain("TRIAGE ASSIGNMENT MARKER");
    const fallback = await resolvePlanningModeSystemPrompt({ getSettings: vi.fn().mockRejectedValue(new Error("broken")), getWorkflowDefinition: vi.fn().mockRejectedValue(new Error("broken")) } as unknown as TaskStore);
    expect(fallback).toContain("task specification agent");
  });
});
