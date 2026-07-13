import { describe, expect, it, vi, beforeEach } from "vitest";
import { workflowAuthoringEngineMock } from "./helpers/engine-workflow-authoring-mock.js";

const resolveSecretAccessPolicyMock = vi.hoisted(() => vi.fn());
const revealSecretMock = vi.hoisted(() => vi.fn());
const listSecretsMock = vi.hoisted(() => vi.fn());
const approvalCreateMock = vi.hoisted(() => vi.fn());
const approvalFindLatestByDedupeKeyMock = vi.hoisted(() => vi.fn());
const recordRunAuditEventMock = vi.hoisted(() => vi.fn());
const assertNoSecretPlaintextMock = vi.hoisted(() => vi.fn());

vi.mock("@fusion/dashboard", () => ({
  registerGithubTrackingHook: vi.fn(),
  // FNXC:CliTests 2026-07-13-09:40: Missing dashboard barrel exports added for mock completeness (scripts/check-cli-dashboard-mock-completeness.mjs gate).
  GitLabClient: vi.fn(),
  resolveGitlabAuth: vi.fn(() => ({})),
  buildGitLabTaskProvenance: vi.fn(() => ({})),
  isGitLabAlreadyImported: vi.fn(),
  buildGitLabTaskDescription: vi.fn(),
}));
vi.mock("@fusion/engine", () => ({
  ...workflowAuthoringEngineMock,
  createFnAgent: vi.fn(),
  fetchWebContent: vi.fn(),
  assertNoSecretPlaintext: assertNoSecretPlaintextMock,
  emitGoalRetrievalAudit: vi.fn(),
  createWorkflowAuthoringTools: vi.fn(() => ({})),
  workflowListParams: {},
  workflowGetParams: {},
  workflowSelectParams: {},
  workflowCreateParams: {},
  workflowUpdateParams: {},
  workflowDeleteParams: {},
  workflowSettingsParams: {},
  traitListParams: {},
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  class MockTaskStore {
    async init() {}
    async getSecretsStore() {
      return { listSecrets: listSecretsMock, revealSecret: revealSecretMock };
    }
    getGlobalSettingsStore() {
      return { getSettings: async () => ({ secretsAccessPolicy: "prompt" }) };
    }
    recordRunAuditEvent = recordRunAuditEventMock;
    getDatabase() {
      return {} as any;
    }
  }
  class MockApprovalRequestStore {
    constructor(_db: unknown) {}
    findLatestByDedupeKey = approvalFindLatestByDedupeKeyMock;
    create = approvalCreateMock;
  }

  return {
    ...actual,
    TaskStore: MockTaskStore,
    ApprovalRequestStore: MockApprovalRequestStore,
    resolveSecretAccessPolicy: resolveSecretAccessPolicyMock,
  };
});

import kbExtension from "../extension.js";

describe("extension fn_secret_get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSecretsMock.mockImplementation((scope?: "project" | "global") => {
      if (scope === "project") return [{ id: "s1", key: "API_KEY", accessPolicy: "auto" }];
      return [];
    });
    revealSecretMock.mockResolvedValue({ key: "API_KEY", plaintextValue: "secret-value" });
    resolveSecretAccessPolicyMock.mockReturnValue({ policy: "auto", source: "secret" });
    approvalFindLatestByDedupeKeyMock.mockReturnValue(null);
    approvalCreateMock.mockReturnValue({ id: "apr-1", status: "pending" });
    assertNoSecretPlaintextMock.mockImplementation(() => {});
  });

  it("returns value for auto policy", async () => {
    const tools = new Map<string, any>();
    kbExtension({ registerTool: (d: any) => tools.set(d.name, d), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerFlag: vi.fn(), on: vi.fn() } as any);
    const tool = tools.get("fn_secret_get");
    const result = await tool.execute("id", { key: "API_KEY" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1", runId: "run-1" });
    expect(result.details.value).toBe("secret-value");
    expect(approvalCreateMock).not.toHaveBeenCalled();
    const event = recordRunAuditEventMock.mock.calls[0][0];
    expect(event.mutationType).toBe("secret:read");
    expect(event.metadata).toEqual({ key: "API_KEY", scope: "project" });
    expect(event.metadata).not.toHaveProperty("plaintextValue");
    expect(event.metadata).not.toHaveProperty("value");
    expect(event.metadata).not.toHaveProperty("ciphertext");
    expect(event.metadata).not.toHaveProperty("nonce");
    expect(event.metadata).not.toHaveProperty("decrypted");
    expect(JSON.stringify(event)).not.toContain("secret-value");
  });

  it("returns pending_approval for prompt policy", async () => {
    resolveSecretAccessPolicyMock.mockReturnValue({ policy: "prompt", source: "secret" });
    const tools = new Map<string, any>();
    kbExtension({ registerTool: (d: any) => tools.set(d.name, d), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerFlag: vi.fn(), on: vi.fn() } as any);
    const tool = tools.get("fn_secret_get");
    const result = await tool.execute("id", { key: "API_KEY" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1" });
    expect(result.details.outcome).toBe("pending_approval");
    expect(approvalCreateMock).toHaveBeenCalled();
  });

  it("skips audit emission if metadata guard throws", async () => {
    assertNoSecretPlaintextMock.mockImplementation(() => {
      throw new Error("secret audit metadata may not include plaintext fields");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tools = new Map<string, any>();
    kbExtension({ registerTool: (d: any) => tools.set(d.name, d), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerFlag: vi.fn(), on: vi.fn() } as any);
    const tool = tools.get("fn_secret_get");

    const result = await tool.execute("id", { key: "API_KEY" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1", runId: "run-1" });
    expect(result.details.value).toBe("secret-value");
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns denied for deny policy and not found when missing", async () => {
    const tools = new Map<string, any>();
    kbExtension({ registerTool: (d: any) => tools.set(d.name, d), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerFlag: vi.fn(), on: vi.fn() } as any);
    const tool = tools.get("fn_secret_get");

    resolveSecretAccessPolicyMock.mockReturnValue({ policy: "deny", source: "secret" });
    const denied = await tool.execute("id", { key: "API_KEY" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1", runId: "run-1" });
    expect(denied.details.error).toBe("denied");
    expect(revealSecretMock).not.toHaveBeenCalled();
    expect(approvalCreateMock).not.toHaveBeenCalled();

    listSecretsMock.mockReturnValue([]);
    const missing = await tool.execute("id", { key: "NOPE" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1" });
    expect(missing.details.error).toBe("not-found");
  });

  it("uses explicit scope when provided, otherwise falls back project then global", async () => {
    listSecretsMock.mockImplementation((scope?: "project" | "global") => {
      if (scope === "project") return [{ id: "p1", key: "SHARED", accessPolicy: "auto" }];
      if (scope === "global") return [{ id: "g1", key: "SHARED", accessPolicy: "auto" }];
      return [];
    });

    const tools = new Map<string, any>();
    kbExtension({ registerTool: (d: any) => tools.set(d.name, d), registerCommand: vi.fn(), registerShortcut: vi.fn(), registerFlag: vi.fn(), on: vi.fn() } as any);
    const tool = tools.get("fn_secret_get");

    await tool.execute("id", { key: "SHARED", scope: "global" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1" });
    expect(revealSecretMock).toHaveBeenLastCalledWith("g1", "global", { agentId: "agent-1" });

    await tool.execute("id", { key: "SHARED" }, undefined, undefined, { cwd: process.cwd(), agentId: "agent-1" });
    expect(revealSecretMock).toHaveBeenLastCalledWith("p1", "project", { agentId: "agent-1" });
  });
});
