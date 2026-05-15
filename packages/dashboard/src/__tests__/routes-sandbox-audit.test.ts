import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const mockGetRunDetail = vi.fn();
const mockGetRunAuditEvents = vi.fn();

vi.mock("@fusion/core", () => ({
  AgentStore: class MockAgentStore {
    init = vi.fn().mockResolvedValue(undefined);
    getRunDetail = mockGetRunDetail;
  },
  ChatStore: class MockChatStore {
    init = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: vi.fn(),
}));

class MockStore {
  getRunAuditEvents = mockGetRunAuditEvents;
  getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);
  getMutationsForRun = vi.fn().mockResolvedValue([]);
  getRootDir() {
    return "/tmp/fn-4640-test";
  }
  getFusionDir() {
    return "/tmp/fn-4640-test/.fusion";
  }
}

function mockRun() {
  return {
    id: "run-001",
    agentId: "agent-001",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    status: "active",
    contextSnapshot: { taskId: "FN-001" },
  };
}

describe("sandbox run-audit route behavior", () => {
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createServer } = await import("../server.js");
    app = createServer(new MockStore() as any);
    mockGetRunDetail.mockResolvedValue(mockRun());
    mockGetRunAuditEvents.mockReturnValue([]);
  });

  it("accepts domain=sandbox filter", async () => {
    const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit?domain=sandbox");
    expect(response.status).toBe(200);
    expect(mockGetRunAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ domain: "sandbox" }));
  });

  it("rejects invalid domain with updated four-domain message", async () => {
    const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit?domain=nope");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("domain must be one of: database, git, filesystem, sandbox");
  });

  it("normalizes sandbox events with Sandbox-prefixed summary and timeline bucket", async () => {
    mockGetRunAuditEvents.mockReturnValue([
      {
        id: "audit-1",
        timestamp: "2026-01-01T00:01:00.000Z",
        agentId: "agent-001",
        runId: "run-001",
        domain: "sandbox",
        mutationType: "sandbox:run",
        target: "native",
        taskId: "FN-001",
      },
    ]);

    const auditResponse = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit");
    expect(auditResponse.status).toBe(200);
    expect(auditResponse.body.events[0].domain).toBe("sandbox");
    expect(auditResponse.body.events[0].summary.startsWith("Sandbox")).toBe(true);

    const timelineResponse = await request(app, "GET", "/api/agents/agent-001/runs/run-001/timeline");
    expect(timelineResponse.status).toBe(200);
    expect(timelineResponse.body.auditByDomain.sandbox).toHaveLength(1);
  });
});
