/*
 * FNXC:PlannerOversight 2026-07-04-13:00:
 * FN-7510 dedicated regression coverage: planner oversight defaults to full
 * steering/control ("autonomous") for every workflow unless explicitly
 * disabled at the workflow-setting scope or the per-task override scope.
 * Precedence is task override -> workflow effective value -> "autonomous"
 * declaration default (see resolveEffectivePlannerOversightLevel).
 */
import { describe, it, expect, vi } from "vitest";

import { BUILTIN_OVERSIGHT_SETTINGS, BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { DEFAULT_PLANNER_OVERSIGHT_LEVEL } from "../types.js";
import {
  resolveEffectiveSettingsById,
  resolveEffectivePlannerOversightLevel,
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

describe("plannerOversightLevel default (FN-7510)", () => {
  it("(a) the declaration default is the full-steering value 'autonomous'", () => {
    const decl = BUILTIN_OVERSIGHT_SETTINGS.find((s) => s.id === "plannerOversightLevel");
    expect(decl).toBeDefined();
    expect(decl?.default).toBe("autonomous");
    expect(decl?.default).toBe(DEFAULT_PLANNER_OVERSIGHT_LEVEL);
    // The declaration lives in the composed catalog every built-in workflow spreads.
    expect(BUILTIN_WORKFLOW_SETTINGS.some((s) => s.id === "plannerOversightLevel")).toBe(true);
  });

  it("(b) resolveEffectiveSettingsById for a built-in workflow with no stored value returns full steering", async () => {
    const store = makeStore({});
    const eff = await resolveEffectiveSettingsById(store, "builtin:coding", PROJECT);
    expect(eff.plannerOversightLevel).toBe("autonomous");
  });

  it("(c) an explicit stored workflow value overrides the default ('off')", async () => {
    const store = makeStore({ plannerOversightLevel: "off" });
    const eff = await resolveEffectiveSettingsById(store, "builtin:coding", PROJECT);
    expect(eff.plannerOversightLevel).toBe("off");
  });

  it("(c) an explicit stored workflow value overrides the default ('steer')", async () => {
    const store = makeStore({ plannerOversightLevel: "steer" });
    const eff = await resolveEffectiveSettingsById(store, "builtin:coding", PROJECT);
    expect(eff.plannerOversightLevel).toBe("steer");
  });

  it("(d) an unset per-task override falls through to the workflow/default level", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, "autonomous")).toBe("autonomous");
    expect(resolveEffectivePlannerOversightLevel(null, "steer")).toBe("steer");
  });

  it("(d) an explicit per-task override wins over the workflow value", () => {
    expect(resolveEffectivePlannerOversightLevel("steer", "autonomous")).toBe("steer");
    expect(resolveEffectivePlannerOversightLevel("off", "autonomous")).toBe("off");
  });

  it("(e) 'off' is honored at the workflow scope when no task override is set", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, "off")).toBe("off");
  });

  it("(e) 'off' is honored at the per-task scope even when the workflow value is full steering", () => {
    expect(resolveEffectivePlannerOversightLevel("off", "autonomous")).toBe("off");
  });

  it("both workflow value and task override unset resolve to full steering (unless-explicitly-disabled)", () => {
    expect(resolveEffectivePlannerOversightLevel(undefined, undefined)).toBe(DEFAULT_PLANNER_OVERSIGHT_LEVEL);
  });
});
