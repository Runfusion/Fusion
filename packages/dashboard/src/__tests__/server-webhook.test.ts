import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { Task, TaskStore, PrInfo, IssueInfo } from "@fusion/core";
import { createServer } from "../server.js";
import { getGitHubAppConfig } from "../github-webhooks.js";

// Mock the github-webhooks module
vi.mock("../github-webhooks.js", async () => {
  const actual = await vi.importActual<typeof import("../github-webhooks.js")>("../github-webhooks.js");
  return {
    ...actual,
    getGitHubAppConfig: vi.fn(),
  };
});

const mockGetGitHubAppConfig = vi.mocked(getGitHubAppConfig);

async function detectLoopbackBinding(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

const loopbackBindingAvailable = await detectLoopbackBinding();
const webhookIntegrationTest = loopbackBindingAvailable ? it : it.skip;

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();
  private rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    super();
    this.rootDir = rootDir;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getFusionDir(): string {
    return this.rootDir + "/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  async listTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async getTask(id: string): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) {
      const error = Object.assign(new Error("Task not found"), { code: "ENOENT" });
      throw error;
    }
    return task;
  }

  async updatePrInfo(taskId: string, prInfo: PrInfo): Promise<Task> {
    const task = await this.getTask(taskId);
    const updated = { ...task, prInfo };
    this.tasks.set(taskId, updated);
    this.emit("task:updated", updated);
    return updated;
  }

  async updateIssueInfo(taskId: string, issueInfo: IssueInfo): Promise<Task> {
    const task = await this.getTask(taskId);
    const updated = { ...task, issueInfo };
    this.tasks.set(taskId, updated);
    this.emit("task:updated", updated);
    return updated;
  }

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.emit("task:created", task);
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      getMission: vi.fn(),
      createMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      listMilestones: vi.fn().mockResolvedValue([]),
      getMilestone: vi.fn(),
      addMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      reorderMilestones: vi.fn(),
      listSlices: vi.fn().mockResolvedValue([]),
      getSlice: vi.fn(),
      addSlice: vi.fn(),
      updateSlice: vi.fn(),
      deleteSlice: vi.fn(),
      reorderSlices: vi.fn(),
      activateSlice: vi.fn(),
      listFeatures: vi.fn().mockResolvedValue([]),
      getFeature: vi.fn(),
      addFeature: vi.fn(),
      updateFeature: vi.fn(),
      deleteFeature: vi.fn(),
      linkFeatureToTask: vi.fn(),
      unlinkFeatureFromTask: vi.fn(),
      getFeatureRollups: vi.fn().mockResolvedValue([]),
    };
  }
}

function createHmacSignature(payload: string, secret: string): string {
  const { createHmac } = require("node:crypto");
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

function createPrTask(id: string, url: string, number: number, status: PrInfo["status"] = "open"): Task {
  return {
    id,
    title: "Test task",
    description: "Test description",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    columnMovedAt: "2026-03-30T00:00:00.000Z",
    prInfo: {
      url,
      number,
      status,
      title: "Test PR",
      headBranch: "feature",
      baseBranch: "main",
      commentCount: 0,
      lastCheckedAt: "2026-03-30T00:00:00.000Z",
    },
  };
}

function createIssueTask(id: string, url: string, number: number, state: IssueInfo["state"] = "open"): Task {
  return {
    id,
    title: "Test task",
    description: "Test description",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    columnMovedAt: "2026-03-30T00:00:00.000Z",
    issueInfo: {
      url,
      number,
      state,
      title: "Test Issue",
    },
  };
}

describe("POST /api/github/webhooks", () => {
  const mockConfig = {
    appId: "12345",
    privateKey: "mock-private-key",
    webhookSecret: "webhook-secret",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubAppConfig.mockReturnValue(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postWebhook(
    port: number,
    payload: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/github/webhooks",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  webhookIntegrationTest("returns 503 when GitHub App is not configured", async () => {
    mockGetGitHubAppConfig.mockReturnValue(null);

    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const response = await postWebhook(port, JSON.stringify({ action: "opened" }));

    expect(response.status).toBe(503);
    expect(response.body.error).toContain("not configured");

    server.close();
    await once(server, "close");
  });

  webhookIntegrationTest("returns 403 for invalid signature", async () => {
    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const payload = JSON.stringify({ action: "opened", number: 42 });
    const invalidSignature = "sha256=invalid";
    const response = await postWebhook(port, payload, {
      "X-Hub-Signature-256": invalidSignature,
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Signature mismatch/i);

    server.close();
    await once(server, "close");
  });

  webhookIntegrationTest("returns 200 for valid ping event", async () => {
    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const payload = JSON.stringify({ zen: "Keep it logically awesome" });
    const signature = createHmacSignature(payload, mockConfig.webhookSecret);
    const response = await postWebhook(port, payload, {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": "ping",
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Pong");

    server.close();
    await once(server, "close");
  });

  webhookIntegrationTest("returns 202 for unsupported event types", async () => {
    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;

    const payload = JSON.stringify({ action: "pushed" });
    const signature = createHmacSignature(payload, mockConfig.webhookSecret);
    const response = await postWebhook(port, payload, {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": "push",
    });

    expect(response.status).toBe(202);
    expect(response.body.message).toContain("not supported");

    server.close();
    await once(server, "close");
  });

  webhookIntegrationTest("returns 202 for issue_comment on regular issues (not PRs)", async () => {
    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    // Issue comment without pull_request field
    const payload = JSON.stringify({
      action: "created",
      issue: { number: 123 }, // No pull_request field → regular issue
      repository: { owner: { login: "owner" }, name: "repo" },
      installation: { id: 12345 },
      comment: { id: 456, body: "Issue comment" },
    });
    const signature = createHmacSignature(payload, mockConfig.webhookSecret);
    const response = await postWebhook(port, payload, {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": "issue_comment",
    });

    expect(response.status).toBe(202);
    expect(response.body.message).toContain("not relevant");

    server.close();
    await once(server, "close");
  });

  webhookIntegrationTest("returns 500 when installation token cannot be fetched", async () => {
    const store = new MockStore();
    const app = createServer(store as any);
    const server = app.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    // Valid PR event with missing installation data
    const payload = JSON.stringify({
      action: "opened",
      number: 42,
      repository: { owner: { login: "owner" }, name: "repo" },
      // No installation field - will cause token fetch to fail
    });
    const signature = createHmacSignature(payload, mockConfig.webhookSecret);
    const response = await postWebhook(port, payload, {
      "X-Hub-Signature-256": signature,
      "X-GitHub-Event": "pull_request",
    });

    // Should return 400 for missing installation data
    expect([400, 500]).toContain(response.status);

    server.close();
    await once(server, "close");
  });
});
