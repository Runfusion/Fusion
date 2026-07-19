/*
 * FNXC:HeartbeatPatrol 2026-07-14-23:38:
 * Idle no-task heartbeat patrol defaults on for compatibility, but an explicit workflow false must survive effective-settings resolution so operators can disable proactive task creation without touching planner oversight recovery.
 */
import { describe, expect, it, vi } from "vitest";

import { BUILTIN_OVERSIGHT_SETTINGS, BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import {
  resolveEffectivePlannerHeartbeatPatrolEnabled,
  resolveEffectiveSettingsById,
  type WorkflowSettingsResolverStore,
} from "../workflow-settings-resolver.js";

const PROJECT = "proj-1";

function makeStore(values?: Record<string, unknown>): WorkflowSettingsResolverStore {
  return {
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(() => values ?? {}),
    getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
  };
}

describe("plannerHeartbeatPatrolEnabled default (FN-7963)", () => {
  it("declares the workflow-native boolean default in the full catalog", () => {
    const decl = BUILTIN_OVERSIGHT_SETTINGS.find((setting) => setting.id === "plannerHeartbeatPatrolEnabled");

    expect(decl).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(BUILTIN_WORKFLOW_SETTINGS.some((setting) => setting.id === "plannerHeartbeatPatrolEnabled")).toBe(true);
  });

  it("resolves unset built-in workflow patrol to true", async () => {
    const eff = await resolveEffectiveSettingsById(makeStore({}), "builtin:coding", PROJECT);

    expect(eff.plannerHeartbeatPatrolEnabled).toBe(true);
    expect(resolveEffectivePlannerHeartbeatPatrolEnabled(eff)).toBe(true);
  });

  it("honors explicit stored false", async () => {
    const eff = await resolveEffectiveSettingsById(
      makeStore({ plannerHeartbeatPatrolEnabled: false }),
      "builtin:coding",
      PROJECT,
    );

    expect(eff.plannerHeartbeatPatrolEnabled).toBe(false);
    expect(resolveEffectivePlannerHeartbeatPatrolEnabled(eff)).toBe(false);
  });

  it("honors explicit stored true", async () => {
    const eff = await resolveEffectiveSettingsById(
      makeStore({ plannerHeartbeatPatrolEnabled: true }),
      "builtin:coding",
      PROJECT,
    );

    expect(eff.plannerHeartbeatPatrolEnabled).toBe(true);
    expect(resolveEffectivePlannerHeartbeatPatrolEnabled(eff)).toBe(true);
  });
});
