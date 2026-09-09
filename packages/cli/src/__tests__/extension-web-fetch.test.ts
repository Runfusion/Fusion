import { describe, expect, it, vi } from "vitest";
import { workflowAuthoringEngineMock } from "./helpers/engine-workflow-authoring-mock.js";

const fetchWebContentMock = vi.hoisted(() => vi.fn());

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: vi.fn(),
  // FNXC:CliTests 2026-07-13-09:40: Missing dashboard barrel exports added for mock completeness (scripts/check-mock-completeness.mjs gate).
  GitLabClient: vi.fn(),
  resolveGitlabAuth: vi.fn(() => ({})),
  buildGitLabTaskProvenance: vi.fn(() => ({})),
  isGitLabAlreadyImported: vi.fn(),
  buildGitLabTaskDescription: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  ...workflowAuthoringEngineMock,
  // FNXC:ToolPermissionGates 2026-07-26-14:55: extension.ts now imports the agent action gate; mock completeness gate requires these names.
  evaluateAgentActionGate: vi.fn(() => ({ disposition: "allow", category: "exempt", toolName: "", operation: "", summary: "", resourceType: "other", approvalDedupeKey: "", metadata: {} })),
  resolveGateOutcome: vi.fn(() => ({ outcome: "allow" })),
  createFnAgent: vi.fn(),
  createAgentTask: vi.fn(),
  fetchWebContent: fetchWebContentMock,
  // FNXC:MissionValidationRepair 2026-08-11-02:35: FN-8947 adds feature-repair target resolution to extension.ts, so isolated engine mocks must export it.
  resolveFeatureRepairTargets: vi.fn(),
  // FNXC:MissionAutoReconcile 2026-08-11-03:27: FN-8948 exposes the mission reconciliation authority through extension.ts.
  reconcileMissionState: vi.fn(),
  emitGoalRetrievalAudit: vi.fn(),
  createWorkflowAuthoringTools: vi.fn(() => ({})),
  workflowListParams: {},
  workflowGetParams: {},
  workflowValidateParams: {}, // FNXC:Round10 FN-7911 added this export to @fusion/engine barrel
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
  normalizeAgentLogPaging: vi.fn(() => ({ limit: 100, offset: 0 })),
  renderAgentLogEntries: vi.fn(() => ""),
  buildTaskAgentLogReadText: vi.fn(() => ""),
}));

import kbExtension from "../extension.js";

describe("extension fn_web_fetch", () => {
  it("registers and executes fn_web_fetch", async () => {
    const tools = new Map<string, any>();
    const api = {
      registerTool(def: any) {
        tools.set(def.name, def);
      },
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      on: vi.fn(),
    } as any;

    fetchWebContentMock.mockResolvedValue({
      finalUrl: "https://example.com/final",
      status: 200,
      contentType: "text/plain",
      title: "Example",
      content: "hello world",
      truncated: false,
      bytesRead: 11,
    });

    kbExtension(api);
    const tool = tools.get("fn_web_fetch");
    expect(tool).toBeTruthy();

    const result = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, { cwd: process.cwd() });
    expect(fetchWebContentMock).toHaveBeenCalledWith("https://example.com", { timeoutMs: undefined, maxBytes: undefined });
    expect(result.content[0].text).toContain("https://example.com/final");
    expect(result.details.status).toBe(200);
  });
});
