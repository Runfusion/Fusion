import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { installExecMock } from "./fixtures/exec-mock.js";

describe("workflow integration contracts", () => {
  it("guards against execSync usage in workflow-oriented execution fixtures", () => {
    const execMock = installExecMock();
    execMock.assertExecSyncUnused();
    expect(typeof plugin.manifest.id).toBe("string");
  });

  it.skip("TODO(FN-3768): execute script-mode workflow handler once plugin workflow step contributions are available", () => {
    // Missing in this branch: cli-printing-press workflow step contribution + script handler wiring.
  });

  it.skip("TODO(FN-3768): run through runWorkflowSteps with plugin:cli-printing-press:<id>", () => {
    // packages/core resolvePluginWorkflowStep currently hard-codes mode="prompt".
  });
});
