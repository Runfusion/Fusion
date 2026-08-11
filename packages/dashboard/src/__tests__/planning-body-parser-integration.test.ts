// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

/**
 * FNXC:GitHubPlanningSourceIssue 2026-08-09-15:18:
 * This boots server.ts rather than a registrar-only router because the global 100 KiB parser runs
 * before planning routes. A production-sized capture must reach route validation so the capture
 * contract is usable outside unit harnesses that install an unlimited express.json() parser.
 */
class PlanningParserStore extends EventEmitter {
  getRootDir() { return process.cwd(); }
  getFusionDir() { return `${process.cwd()}/.fusion`; }
  getSettings = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getSettingsFast = this.getSettings;
  getGlobalSettingsStore = () => ({ getSettings: async () => ({}) });
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
}

const app = () => createServer(new PlanningParserStore() as unknown as TaskStore, { noAuth: true });

function productionSizedCaptureBodies(): string[] {
  // Four valid, whole image-bearing bodies total just below the 1,000,000-character transport cap.
  return Array.from({ length: 4 }, () => `![capture](https://github.com/user-attachments/assets/image.png)${"x".repeat(249_900)}`);
}

describe("planning image capture body parser boundary", () => {
  it("passes a production-sized capture to planning route validation instead of the global 100 KiB rejection", async () => {
    const body = JSON.stringify({
      initialPlan: "Plan GitHub issue evidence import",
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        issueNumber: 42,
        url: "https://github.com/owner/repo/issues/42",
        imageBodies: productionSizedCaptureBodies(),
        // Deliberately invalid after an otherwise contract-sized payload: 400 proves the route,
        // not the global parser, consumed and validated the full request.
        commentsUnavailable: "false",
      },
    });

    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
    const response = await request(app(), "POST", "/api/planning/start-streaming", body, { "content-type": "application/json" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "sourceIssue commentsUnavailable must be boolean" });
  });
});
