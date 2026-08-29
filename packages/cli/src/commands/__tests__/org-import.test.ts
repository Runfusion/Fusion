import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(), materializeOrgBundle: vi.fn(), agentInit: vi.fn(), agentClose: vi.fn(), shutdown: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@fusion/core", () => ({
  AgentStore: vi.fn(function AgentStore() { return { init: mocks.agentInit, close: mocks.agentClose }; }),
  RoutineStore: vi.fn(function RoutineStore() {}), AutomationStore: vi.fn(function AutomationStore() {}),
  createTaskStoreForBackend: vi.fn(async () => ({ taskStore: { asyncLayer: {} }, shutdown: mocks.shutdown })),
  materializeOrgBundle: mocks.materializeOrgBundle,
}));
vi.mock("../../project-context.js", () => ({ resolveProjectPathOnly: vi.fn(async () => "/projects/demo") }));

import { runOrgImport } from "../org-import.js";

describe("runOrgImport", () => {
  it("passes dry-run and collision policy to bundle materialization", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ version: 1 }));
    mocks.materializeOrgBundle.mockResolvedValue({ created: {}, skipped: {}, errors: [] });
    await runOrgImport("bundle.json", { project: "demo", dryRun: true, collisionMode: "suffix" });
    expect(mocks.materializeOrgBundle).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: "/projects/demo" }),
      { version: 1 },
      { dryRun: true, collisionMode: "suffix" },
    );
    expect(mocks.agentClose).toHaveBeenCalled();
    expect(mocks.shutdown).toHaveBeenCalled();
  });
});
