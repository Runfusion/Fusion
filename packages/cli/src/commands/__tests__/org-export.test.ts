import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assembleOrgBundle: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), agentInit: vi.fn(), agentClose: vi.fn(), shutdown: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile, rename: mocks.rename }));
vi.mock("@fusion/core", () => ({
  AgentStore: vi.fn(function AgentStore() { return { init: mocks.agentInit, close: mocks.agentClose }; }),
  RoutineStore: vi.fn(function RoutineStore() {}), AutomationStore: vi.fn(function AutomationStore() {}),
  createTaskStoreForBackend: vi.fn(async () => ({ taskStore: { asyncLayer: {} }, shutdown: mocks.shutdown })),
  assembleOrgBundle: mocks.assembleOrgBundle,
}));
vi.mock("../../project-context.js", () => ({ resolveProjectPathOnly: vi.fn(async () => "/projects/demo") }));

import { runOrgExport } from "../org-export.js";

describe("runOrgExport", () => {
  it("writes the secret-scrubbed organization bundle atomically", async () => {
    mocks.assembleOrgBundle.mockResolvedValue({ agents: [], skills: [], routines: [], automations: [] });
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    await runOrgExport("./bundle.json", { project: "demo" });
    expect(mocks.assembleOrgBundle).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/projects/demo" }));
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.stringMatching(/bundle\.json\.tmp$/), expect.any(String));
    expect(mocks.rename).toHaveBeenCalledWith(expect.stringMatching(/bundle\.json\.tmp$/), expect.stringMatching(/bundle\.json$/));
    expect(mocks.agentClose).toHaveBeenCalled();
    expect(mocks.shutdown).toHaveBeenCalled();
  });
});
