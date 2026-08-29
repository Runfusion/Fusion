import { describe, expect, it } from "vitest";
import {
  WorkflowExtensionRegistry,
  WorkflowExtensionRegistrationError,
} from "../workflows/workflow-extension-registry.js";
import type { WorkflowExtensionContribution } from "../workflows/workflow-extension-types.js";

function extension(
  extensionId = "move-policy",
  kind: WorkflowExtensionContribution["kind"] = "move-policy",
): WorkflowExtensionContribution {
  return {
    extensionId,
    name: "Move Policy",
    kind,
    schemaVersion: 1,
    fallback: "degradeToDefault",
  };
}

describe("WorkflowExtensionRegistry", () => {
  it("registers and lists plugin-namespaced workflow extensions", () => {
    const registry = new WorkflowExtensionRegistry();

    const registered = registry.register("plugin-a", extension());

    expect(registered.id).toBe("plugin:plugin-a:move-policy");
    expect(registry.get("plugin:plugin-a:move-policy")).toBe(registered);
    expect(registry.list("move-policy")).toEqual([registered]);
    expect(registry.list("work-engine")).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension());

    expect(() => registry.register("plugin-a", extension())).toThrow(WorkflowExtensionRegistrationError);
  });

  it("unregisters all extensions for a plugin", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension("move-policy"));
    registry.register("plugin-a", extension("work-engine", "work-engine"));
    registry.register("plugin-b", extension("move-policy"));

    expect(registry.unregisterPlugin("plugin-a")).toEqual([
      "plugin:plugin-a:move-policy",
      "plugin:plugin-a:work-engine",
    ]);
    expect(registry.list()).toHaveLength(1);
  });

  it("marks extensions degraded without removing definitions", () => {
    const registry = new WorkflowExtensionRegistry();
    registry.register("plugin-a", extension());

    expect(registry.degrade(["plugin:plugin-a:move-policy"], "force-disabled", "disabled")).toEqual([
      "plugin:plugin-a:move-policy",
    ]);
    expect(registry.get("plugin:plugin-a:move-policy")?.degraded).toEqual({
      reason: "force-disabled",
      message: "disabled",
    });
  });
});
