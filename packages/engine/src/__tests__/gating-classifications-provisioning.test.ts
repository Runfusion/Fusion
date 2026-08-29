import { describe, expect, it } from "vitest";
import {
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  PERMANENT_AGENT_TASK_MUTATION_TOOLS,
  TASK_AGENT_MUTATION_TOOLS,
} from "../execution/gating-classifications.js";

describe("gating classifications provisioning split", () => {
  it("keeps provisioning tools out of action-gate set", () => {
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_agent_create")).toBe(false);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_agent_delete")).toBe(false);
  });

  it("retains provisioning tools in permanent/task mutation sets", () => {
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_agent_create")).toBe(true);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_agent_delete")).toBe(true);
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_agent_create")).toBe(true);
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_agent_delete")).toBe(true);
  });

  it("classifies provider task imports as action-gated task mutations only", () => {
    for (const tool of ["fn_task_import_github", "fn_task_import_github_issue", "fn_task_import_gitlab_project_issues", "fn_task_import_gitlab_group_issues", "fn_task_import_gitlab_merge_requests"]) {
      expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has(tool)).toBe(true);
      expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has(tool)).toBe(false);
      expect(TASK_AGENT_MUTATION_TOOLS.has(tool)).toBe(true);
    }
  });
});
