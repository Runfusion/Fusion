import { describe, expect, it } from "vitest";
import {
  computeAccessState,
  isValidPermission,
  normalizePermissions,
} from "../agents/agent-permissions.js";
import { AGENT_PERMISSIONS } from "../types.js";
import type { Agent, AgentCapability, AgentPermission } from "../types.js";

function makeAgent(role: AgentCapability, permissions?: Record<string, boolean>): Agent {
  return {
    id: "agent-001",
    name: "Test Agent",
    role,
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    permissions,
  };
}

describe("normalizePermissions", () => {
  it("returns empty set for empty input", () => {
    expect(normalizePermissions({})).toEqual(new Set());
  });

  it("returns only valid permission keys", () => {
    const result = normalizePermissions({
      "tasks:execute": true,
      "foo:bar": true,
      "budget:spend": true,
      "agents:view": true,
    });

    expect(result).toEqual(new Set<AgentPermission>(["tasks:execute", "agents:view"]));
  });

  it("returns only granted permissions", () => {
    const result = normalizePermissions({
      "tasks:execute": true,
      "tasks:assign": false,
      "agents:view": false,
    });

    expect(result).toEqual(new Set<AgentPermission>(["tasks:execute"]));
  });

  it("returns all valid permissions when all are true", () => {
    const allPermissions = Object.fromEntries(
      AGENT_PERMISSIONS.map((permission) => [permission, true]),
    );

    const result = normalizePermissions(allPermissions);

    expect(result).toEqual(new Set<AgentPermission>(AGENT_PERMISSIONS));
  });
});

describe("isValidPermission", () => {
  it("returns true for every entry in AGENT_PERMISSIONS", () => {
    for (const permission of AGENT_PERMISSIONS) {
      expect(isValidPermission(permission)).toBe(true);
    }
  });

  it("returns false for invalid strings", () => {
    expect(isValidPermission("budget:spend")).toBe(false);
    expect(isValidPermission("invalid")).toBe(false);
    expect(isValidPermission("")).toBe(false);
  });
});

describe("computeAccessState", () => {
  it("executor role gets execute by default and cannot assign tasks", () => {
    const state = computeAccessState(makeAgent("executor"));

    expect(state.canExecuteTasks).toBe(true);
    expect(state.canAssignTasks).toBe(false);
    expect(state.taskAssignSource).toBe("denied");
    expect(state.resolvedPermissions.has("tasks:execute")).toBe(true);
  });

  it("scheduler role gets assign by default", () => {
    const state = computeAccessState(makeAgent("scheduler"));

    expect(state.canAssignTasks).toBe(true);
    expect(state.taskAssignSource).toBe("role_default");
    expect(state.roleDefaultPermissions.has("tasks:assign")).toBe(true);
  });

  it("custom role has no defaults", () => {
    const state = computeAccessState(makeAgent("custom"));

    expect(state.canAssignTasks).toBe(false);
    expect(state.canCreateAgents).toBe(false);
    expect(state.canExecuteTasks).toBe(false);
    expect(state.canReviewTasks).toBe(false);
    expect(state.canMergeTasks).toBe(false);
    expect(state.canDeleteAgents).toBe(false);
    expect(state.canManageMissions).toBe(false);
    expect(state.canSendMessages).toBe(false);
    expect(state.resolvedPermissions.size).toBe(0);
  });

  it("explicit grant enables assignment and reports explicit_grant source", () => {
    const state = computeAccessState(
      makeAgent("executor", { "tasks:assign": true }),
    );

    expect(state.canAssignTasks).toBe(true);
    expect(state.taskAssignSource).toBe("explicit_grant");
  });

  it("explicit false does not remove role defaults", () => {
    const state = computeAccessState(
      makeAgent("executor", { "tasks:execute": false }),
    );

    expect(state.canExecuteTasks).toBe(true);
    expect(state.resolvedPermissions.has("tasks:execute")).toBe(true);
    expect(state.explicitPermissions.has("tasks:execute")).toBe(false);
  });

  it("separates explicit and role-default permissions in mixed cases", () => {
    const state = computeAccessState(
      makeAgent("engineer", {
        "tasks:assign": true,
        "tasks:merge": true,
        "messages:send": true,
      }),
    );

    expect(state.explicitPermissions).toEqual(
      new Set<AgentPermission>(["tasks:assign", "tasks:merge", "messages:send"]),
    );
    expect(state.roleDefaultPermissions).toEqual(
      new Set<AgentPermission>([
        "tasks:execute",
        "tasks:review",
        "agents:view",
        "messages:read",
        "messages:send",
      ]),
    );
    expect(state.resolvedPermissions.has("tasks:assign")).toBe(true);
    expect(state.resolvedPermissions.has("tasks:execute")).toBe(true);
  });

  it("still gets role defaults when permissions field is undefined", () => {
    const state = computeAccessState(makeAgent("reviewer", undefined));

    expect(state.canReviewTasks).toBe(true);
    expect(state.resolvedPermissions.has("tasks:review")).toBe(true);
  });

  it("ignores invalid permission keys", () => {
    const state = computeAccessState(
      makeAgent("custom", { "budget:spend": true, "tasks:execute": true }),
    );

    expect(state.explicitPermissions).toEqual(new Set<AgentPermission>(["tasks:execute"]));
    expect(state.resolvedPermissions.has("tasks:execute")).toBe(true);
    expect(state.resolvedPermissions.has("budget:spend" as AgentPermission)).toBe(false);
  });

  it("resolved permissions are the union of role defaults and explicit grants", () => {
    const state = computeAccessState(
      makeAgent("executor", {
        "tasks:assign": true,
        "agents:create": true,
      }),
    );

    const expected = new Set<AgentPermission>([
      ...state.roleDefaultPermissions,
      ...state.explicitPermissions,
    ]);
    expect(state.resolvedPermissions).toEqual(expected);
  });
});
