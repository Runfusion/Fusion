import { describe, it, expect, vi } from "vitest";

import type { Settings } from "@fusion/core";
import { mergeEffectiveSettings } from "../effective-settings.js";

const PROJECT = "proj-1";

/** A base settings object with real project values for the keys under test. */
function baseSettings(): Settings {
  return {
    workflowStepTimeoutMs: 360_000,
    requirePrApproval: false,
    runStepsInNewSessions: false,
    // A real project value for an absent-default lane — must NOT be clobbered.
    executionProvider: "project-anthropic",
    executionModelId: "claude-project",
  } as unknown as Settings;
}

function makeStore(opts: {
  workflowId?: string;
  values?: Record<string, unknown>;
}) {
  return {
    getTaskWorkflowSelection: vi.fn((_t: string) =>
      opts.workflowId ? { workflowId: opts.workflowId, stepIds: [] } : undefined,
    ),
    getWorkflowDefinition: vi.fn(async (_id: string) => undefined),
    getWorkflowSettingValues: vi.fn((_w: string, _p: string) => opts.values ?? {}),
    getWorkflowSettingsProjectId: vi.fn(() => PROJECT),
  };
}

describe("mergeEffectiveSettings (engine entry merge, U3/KTD-3)", () => {
  it("parity: builtin:coding, nothing stored → merged equals base for moved keys", async () => {
    const store = makeStore({ workflowId: "builtin:coding" });
    const base = baseSettings();
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, base);
    // Declaration defaults are byte-equal to legacy defaults, so these don't change.
    expect(merged.workflowStepTimeoutMs).toBe(360_000);
    expect(merged.requirePrApproval).toBe(false);
    expect(merged.runStepsInNewSessions).toBe(false);
  });

  it("does NOT clobber a real project model-lane value with an undefined effective lane", async () => {
    const store = makeStore({ workflowId: "builtin:coding" }); // no stored lane values
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, baseSettings());
    // executionProvider has no declaration default → absent from effective map →
    // the real project value survives.
    expect(merged.executionProvider).toBe("project-anthropic");
    expect(merged.executionModelId).toBe("claude-project");
  });

  it("pre-migration parity: a CUSTOMIZED base value is NOT clobbered by a declaration default", async () => {
    // The project base still carries a non-default value (pre-U4-migration state);
    // no stored workflow value exists. The declaration default must NOT override it.
    const store = makeStore({ workflowId: "builtin:coding" });
    const base = { ...baseSettings(), verificationFixRetries: 0, workflowStepTimeoutMs: 12_345 } as unknown as Settings;
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, base);
    expect(merged.verificationFixRetries).toBe(0); // not the declaration default (3)
    expect(merged.workflowStepTimeoutMs).toBe(12_345); // not the declaration default (360_000)
  });

  it("post-migration fill: a declaration default fills when the base lacks the key", async () => {
    const store = makeStore({ workflowId: "builtin:coding" });
    // Base lacks workflowStepTimeoutMs (moved key removed from project settings).
    const base = { requirePrApproval: false } as unknown as Settings;
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, base);
    expect(merged.workflowStepTimeoutMs).toBe(360_000); // filled from declaration default
  });

  it("a stored value overrides the base", async () => {
    const store = makeStore({
      workflowId: "builtin:coding",
      values: { workflowStepTimeoutMs: 9_000, requirePrApproval: true, executionProvider: "wf-openai" },
    });
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, baseSettings());
    expect(merged.workflowStepTimeoutMs).toBe(9_000);
    expect(merged.requirePrApproval).toBe(true);
    // A stored lane DOES override the project value.
    expect(merged.executionProvider).toBe("wf-openai");
    // Untouched lane keeps the project value.
    expect(merged.executionModelId).toBe("claude-project");
  });

  it("returns a NEW object; the base is not mutated", async () => {
    const store = makeStore({ workflowId: "builtin:coding", values: { workflowStepTimeoutMs: 1 } });
    const base = baseSettings();
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, base);
    expect(base.workflowStepTimeoutMs).toBe(360_000);
    expect(merged).not.toBe(base);
  });

  it("degrades to base on resolver error (never throws)", async () => {
    const store = {
      getTaskWorkflowSelection: vi.fn(() => {
        throw new Error("boom");
      }),
      getWorkflowDefinition: vi.fn(async () => {
        throw new Error("boom");
      }),
      getWorkflowSettingValues: vi.fn(() => {
        throw new Error("boom");
      }),
      getWorkflowSettingsProjectId: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const base = baseSettings();
    const merged = await mergeEffectiveSettings(store as any, { id: "t1" }, base);
    // resolveEffectiveSettings degrades to builtin declaration defaults even when the
    // selection/project throw; the merge stays behavior-inert for the base values.
    expect(merged.workflowStepTimeoutMs).toBe(360_000);
    expect(merged.executionProvider).toBe("project-anthropic");
  });
});
