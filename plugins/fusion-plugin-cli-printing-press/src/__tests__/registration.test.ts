import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import plugin from "../index.js";
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
    } finally {
      h.cleanup();
    }
  });

  it.skip("TODO(FN-3768): assert plugin workflow-step template contributions once shipped", () => {
    // This branch does not yet export workflow step templates/contributions for cli-printing-press.
  });
});
