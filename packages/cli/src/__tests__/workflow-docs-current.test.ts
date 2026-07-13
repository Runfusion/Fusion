import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const doc = (relativePath: string) => readFileSync(resolve(workspaceRoot, relativePath), "utf8");

const workflowSteps = () => doc("docs/workflow-steps.md");
const workflowEditor = () => doc("docs/workflow-editor.md");
const dashboardGuide = () => doc("docs/dashboard-guide.md");
const agents = () => doc("docs/agents.md");
const cliReference = () => doc("docs/cli-reference.md");

/*
FNXC:WorkflowDocs 2026-06-30-09:30:
Workflow docs drift easily when implementation tasks add agent tools or board affordances. Keep this guard targeted to the public docs surfaces that define the current workflow behavior inventory.
*/

describe("workflow documentation current behavior", () => {
  it("documents the current built-in workflow catalog and fail-closed runtime contract", () => {
    const content = workflowSteps();
    for (const id of [
      "builtin:coding",
      "builtin:legacy-coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:marketing",
      "builtin:compound-engineering",
      "builtin:stepwise-coding",
      "builtin:design",
      "builtin:pr-workflow",
      "builtin:lead-generation",
    ]) {
      expect(content).toContain(id);
    }
    expect(content).toContain("fails closed");
    expect(content).toContain("invalid-ir");
    expect(content).toContain("instead of silently falling back");
    expect(content).toContain("An explicit empty list");
    expect(content).toContain('`json-steps` `"depends": []`');
    expect(content).toContain("An absent annotation/key is different");
    expect(content).toContain("default-on gates still run and appear for in-progress tasks when a persisted selection array is empty");
    expect(content).toContain("edit controls show only the persisted selection");
  });

  it("keeps workflow tool docs broader than list/select only", () => {
    const combined = [workflowSteps(), workflowEditor(), agents(), cliReference()].join("\n");
    for (const tool of [
      "fn_workflow_list",
      "fn_workflow_get",
        "fn_workflow_validate",
      "fn_workflow_create",
      "fn_workflow_update",
      "fn_workflow_delete",
      "fn_workflow_settings",
      "fn_trait_list",
      "fn_workflow_select",
      "workflow_id",
    ]) {
      expect(combined).toContain(tool);
    }
    expect(combined).toContain("explicitly requested");
    expect(combined).toContain("tasks they created");
  });

  it("documents aggregate board selection, workflow badges, and create forwarding", () => {
    const content = dashboardGuide();
    expect(content).toContain("All workflows");
    expect(content).toContain("workflow name");
    expect(content).toContain("synthetic aggregate");
    expect(content).toContain("active workflow selection");
    expect(content).toContain("Hidden columns stay workflow-scoped in the aggregate");
    expect(content).toContain("it never submits the synthetic aggregate as a workflow id");
  });

  it("documents current workflow settings ownership and extension task-id semantics", () => {
    const settings = doc("docs/settings-reference.md");
    expect(settings).toContain("Settings → Project Models → Default workflow model lanes");
    expect(settings).toContain("workflow editor Values tab");
    expect(settings).toContain("Built-in prompt overrides");
    expect(settings).toContain("not writable through");

    const cli = cliReference();
    expect(cli).toContain("must pass `task_id`");
    expect(cli).toContain("treats `null` as deleting a stored override");
    expect(cli).toContain("broader-than-default column permission bindings require explicit policy-escalation confirmation");
  });

  it("keeps removed workflow-step CRUD surfaces documented only as removed", () => {
    const content = workflowSteps();
    expect(content).toContain("There is no longer a Settings → Workflow Steps manager or step CRUD form");
    expect(content).toContain("The legacy workflow-step CRUD routes were removed");
    expect(content).not.toContain("create a workflow step in Settings");
    expect(content).not.toContain("Use `POST /api/workflow-steps`");
  });
});
