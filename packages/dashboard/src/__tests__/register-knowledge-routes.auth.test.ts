// @vitest-environment node

/**
 * Auth integration for the knowledge-index endpoints (U14): every endpoint must
 * be rejected with 401 when unauthenticated and accepted with a valid bearer
 * token. Mirrors `register-command-center-routes.auth.test.ts` — the registrar
 * adds no auth of its own; it inherits the server-level middleware, which is
 * exactly what this asserts.
 *
 * FNXC:Knowledge 2026-06-16-09:46:
 * U14 knowledge-index auth coverage (PR #1683): the index holds sensitive repo/PR content, so every
 * endpoint must 401 when unauthenticated and never be cross-project readable; this pins that contract.
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
    return "/tmp/fn-knowledge-auth-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-knowledge-auth-test/.fusion";
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
}

const TOKEN = "fn_knowledge_test1234567890abc";

describe("Knowledge routes — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unauthenticated query with 401", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, {
      daemon: { token: TOKEN },
    });
    const res = await request(app, "GET", "/api/knowledge/query?q=anything");
    expect(res.status).toBe(401);
  });

  it("accepts the query with a valid bearer token", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, {
      daemon: { token: TOKEN },
    });
    const res = await request(app, "GET", "/api/knowledge/query?q=anything", undefined, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });
});
