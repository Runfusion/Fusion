import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import plugin, { CLI_PRINTING_PRESS_WORKFLOW_STEPS } from "../index.js";
import { ensureCliPressSchema } from "../store/cli-press-store.js";
import { makeFakeRegistry } from "./fixtures/registry.js";

describe("plugin registration contracts", () => {
  it("declares expected manifest and semver version", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-cli-printing-press");
    expect(plugin.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(validatePluginManifest(plugin.manifest).valid).toBe(true);
  });

  it("registers schema, routes, dashboard views and executor runtime hook", () => {
    const h = makeFakeRegistry();
    try {
      expect(() => ensureCliPressSchema(h.db)).not.toThrow();
      expect(plugin.routes?.some((route) => route.path === "/drafts")).toBe(true);
      expect(plugin.dashboardViews?.map((view) => view.viewId)).toEqual(["wizard", "manage"]);
      expect(typeof plugin.executorRuntimeEnv).toBe("function");
      expect(plugin.workflowSteps?.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it("contributes script-mode workflow step templates", () => {
    expect(plugin.workflowSteps?.length).toBeGreaterThan(0);
    expect(plugin.workflowSteps).toEqual(CLI_PRINTING_PRESS_WORKFLOW_STEPS);

    for (const step of plugin.workflowSteps ?? []) {
      expect(step.stepId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }

    expect(
      plugin.workflowSteps?.some((step) => step.mode === "script" && step.phase === "pre-merge"),
    ).toBe(true);

    expect(plugin.manifest.workflowSteps?.map((step) => step.stepId)).toEqual(
      plugin.workflowSteps?.map((step) => step.stepId),
    );
    expect(validatePluginManifest(plugin.manifest).valid).toBe(true);
  });
});
