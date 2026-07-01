import { describe, it, expect } from "vitest";
import {
  DENIED_IN_READONLY,
  READONLY_ALLOWLIST,
  ReadonlyViolationError,
  filterCustomToolsForReadonly,
  isReadonlyAllowed,
} from "../workflow-step-tool-policy.js";

describe("workflow-step readonly allowlist policy", () => {
  it("exposes expected readonly allowlist", () => {
    expect(READONLY_ALLOWLIST).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "WebSearch",
      "WebFetch",
      "fn_web_fetch",
      "fn_task_show",
      "fn_task_list",
      "fn_insight_list",
      "fn_insight_show",
      "fn_list_agents",
      "fn_get_agent_config",
    ]);
    expect(isReadonlyAllowed("read")).toBe(true);
    expect(isReadonlyAllowed(" edit ")).toBe(false);
  });

  it("denies write/mutation tool names and keeps readonly custom tools", () => {
    expect(DENIED_IN_READONLY).toEqual(expect.arrayContaining<string>([
      "edit",
      "write",
      "bash",
      "fn_task_create",
      "fn_spawn_agent",
      "fn_delegate_task",
      "fn_update_agent_config",
      "fn_agent_create",
      "fn_agent_delete",
      "fn_task_plan",
      "fn_mission_create",
      "fn_mission_delete",
      "fn_mission_update",
      "fn_mission_backfill_assertions",
      "fn_milestone_add",
      "fn_slice_add",
      "fn_feature_add",
      "fn_feature_delete",
      "fn_slice_delete",
      "fn_milestone_delete",
      "fn_slice_activate",
      "fn_feature_link_task",
      "fn_feature_update",
      "fn_milestone_update",
      "fn_agent_stop",
      "fn_agent_start",
    ]));

    const filtered = filterCustomToolsForReadonly([
      { name: "read" } as any,
      { name: "fn_task_list" } as any,
      { name: "edit" } as any,
      { name: "fn_task_update" } as any,
    ]);

    expect(filtered.allowed.map((tool) => tool.name)).toEqual(["read", "fn_task_list"]);
    expect(filtered.denied).toEqual(["edit", "fn_task_update"]);
  });

  it("allows explicitly approved tool objects without blanket-allowing mcp names", () => {
    const connectedMcpTool = { name: "mcp__docs__lookup" } as any;
    const callerSuppliedMcpNamedTool = { name: "mcp__docs__write" } as any;

    const filtered = filterCustomToolsForReadonly([
      connectedMcpTool,
      callerSuppliedMcpNamedTool,
    ], {
      allowTool: (tool) => tool === connectedMcpTool,
    });

    expect(filtered.allowed).toEqual([connectedMcpTool]);
    expect(filtered.allowed).not.toContain(callerSuppliedMcpNamedTool);
  });

  it("captures readonly violation error shape", () => {
    const err = new ReadonlyViolationError("FN-4366", "Frontend UX Design", "edit");
    expect(err.code).toBe("READONLY_VIOLATION");
    expect(err.taskId).toBe("FN-4366");
    expect(err.stepName).toBe("Frontend UX Design");
    expect(err.toolName).toBe("edit");
    expect(err.message).toContain("[readonly-violation]");
  });
});
