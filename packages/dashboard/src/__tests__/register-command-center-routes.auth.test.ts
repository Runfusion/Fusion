// @vitest-environment node

/**
 * Auth integration for the Command Center endpoints: every endpoint, including
 * `/live`, must be rejected with 401 when unauthenticated and accepted with a
 * valid bearer token. Mirrors `auth-middleware-integration.test.ts` but exercises
 * the U9 routes specifically (the registrar adds no auth of its own — it inherits
 * the server-level middleware, which is exactly what this asserts).
 *
 * FNXC:CommandCenter 2026-06-16-09:44:
 * U9 Command Center auth coverage (PR #1683): every analytics endpoint, including /live, must 401 when
 * unauthenticated — the registrar relies entirely on the server-level bearer middleware, so this pins it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-cc-auth-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-cc-auth-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn().mockReturnValue({ count: 0 }),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }

  getDatabaseHealth() {
    return {
      healthy: true,
      corruptionDetected: false,
      corruptionErrors: [],
      isRunning: false,
      lastCheckedAt: null,
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }

  async backfillCommitAssociationDiffStats() {
    return {
      scannedRows: 0,
      distinctCommits: 0,
      updatedRows: 0,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun: true,
    };
  }
}

const TOKEN = "fn_cc_test1234567890abcdef";
const ENDPOINTS: Array<{ method?: "GET" | "POST"; path: string }> = [
  { path: "/api/command-center/tokens" },
  { path: "/api/command-center/tools" },
  { path: "/api/command-center/activity" },
  { path: "/api/command-center/productivity" },
  { method: "POST", path: "/api/command-center/productivity/backfill-loc" },
  { path: "/api/command-center/plugin-activations" },
  { path: "/api/command-center/team" },
  { path: "/api/command-center/github" },
  { path: "/api/command-center/signals" },
  { path: "/api/command-center/live" },
];

describe("Command Center routes — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests to every endpoint (incl. /live) with 401", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, {
      daemon: { token: TOKEN },
    });
    for (const endpoint of ENDPOINTS) {
      const method = endpoint.method ?? "GET";
      const res = await request(app, method, endpoint.path);
      expect(res.status, `${method} ${endpoint.path} should be 401 unauthenticated`).toBe(401);
    }
  });

  it("accepts every endpoint (incl. /live) with a valid bearer token", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, {
      daemon: { token: TOKEN },
    });
    for (const endpoint of ENDPOINTS) {
      const method = endpoint.method ?? "GET";
      const body = method === "POST" ? JSON.stringify({}) : undefined;
      const res = await request(app, method, endpoint.path, body, {
        Authorization: `Bearer ${TOKEN}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      });
      expect(res.status, `${method} ${endpoint.path} should be 200 with token`).toBe(200);
    }
  });
});
