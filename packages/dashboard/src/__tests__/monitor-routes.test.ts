// @vitest-environment node

/**
 * U13 — Monitor route auth + ingestion. Two security layers:
 *  1. the server-level daemon bearer-token middleware (gates all /api/*), and
 *  2. the route-level monitor ingestion secret (FUSION_MONITOR_INGEST_SECRET).
 * An unauthenticated deploy/incident POST returns 401 and records NOTHING.
 *
 * FNXC:Monitor 2026-06-16-09:44:
 * U13 monitor ingest auth coverage (PR #1683): both the daemon bearer middleware and the route-level
 * ingest secret must hold, and a rejected request must persist nothing — fail-closed, no partial writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";
import {
  isAuthorizedMonitorIngest,
  MONITOR_INGEST_SECRET_ENV,
} from "../routes/monitor-routes.js";

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {});
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-monitor-routes-test";
  }
  getFusionDir(): string {
    return "/tmp/fn-monitor-routes-test/.fusion";
  }
  getDatabase() {
    return {
      exec: vi.fn(),
      bumpLastModified: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        get: vi.fn().mockReturnValue({ count: 0, name: "incidents" }),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }
  getDatabaseHealth() {
    return { healthy: true, corruptionDetected: false, corruptionErrors: [], isRunning: false, lastCheckedAt: null };
  }
  async listTasks(): Promise<Task[]> {
    return [];
  }
}

const DAEMON_TOKEN = "fn_monitor_daemon_1234567890";
const INGEST_SECRET = "monitor_ingest_secret_abcdef";

describe("monitor routes — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[MONITOR_INGEST_SECRET_ENV];
  });
  afterEach(() => {
    delete process.env[MONITOR_INGEST_SECRET_ENV];
  });

  const json = (obj: unknown): string => JSON.stringify(obj);
  const CT = { "content-type": "application/json" };

  it("rejects a deploy POST with no daemon token (401)", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, { daemon: { token: DAEMON_TOKEN } });
    const res = await request(app, "POST", "/api/monitor/deployments", json({ service: "api" }), CT);
    expect(res.status).toBe(401);
  });

  it("rejects a deploy POST that passes daemon auth but has no ingest secret configured (401)", async () => {
    const app = createServer(new MockStore() as unknown as TaskStore, { daemon: { token: DAEMON_TOKEN } });
    const res = await request(app, "POST", "/api/monitor/deployments", json({ service: "api" }), {
      ...CT,
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    });
    // Daemon token allows it past the middleware, but the route requires its own
    // ingest secret which is unset → 401.
    expect(res.status).toBe(401);
  });

  it("rejects an incident POST with a daemon-only token (no ingest secret match) (401)", async () => {
    process.env[MONITOR_INGEST_SECRET_ENV] = INGEST_SECRET;
    const app = createServer(new MockStore() as unknown as TaskStore, { daemon: { token: DAEMON_TOKEN } });
    // Satisfies the daemon middleware but not the route's ingest secret.
    const res = await request(app, "POST", "/api/monitor/incidents", json({ groupingKey: "g1", title: "x" }), {
      ...CT,
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    });
    expect(res.status).toBe(401);
  });

  it("accepts a deploy POST when daemon token == ingest secret", async () => {
    // When the daemon token and ingest secret are the same value, one bearer
    // satisfies both layers → the deploy is recorded (201).
    process.env[MONITOR_INGEST_SECRET_ENV] = DAEMON_TOKEN;
    const app = createServer(new MockStore() as unknown as TaskStore, { daemon: { token: DAEMON_TOKEN } });
    const res = await request(app, "POST", "/api/monitor/deployments", json({ service: "api" }), {
      ...CT,
      Authorization: `Bearer ${DAEMON_TOKEN}`,
    });
    expect(res.status).toBe(201);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });
});

describe("isAuthorizedMonitorIngest", () => {
  it("is false when no secret is configured (never unauthenticated)", () => {
    expect(isAuthorizedMonitorIngest({ authorization: "Bearer anything" }, {})).toBe(false);
  });
  it("is false on a missing token", () => {
    expect(isAuthorizedMonitorIngest({}, { [MONITOR_INGEST_SECRET_ENV]: "s" })).toBe(false);
  });
  it("is false on a wrong token", () => {
    expect(isAuthorizedMonitorIngest({ authorization: "Bearer wrong" }, { [MONITOR_INGEST_SECRET_ENV]: "right" })).toBe(false);
  });
  it("is true on a matching token", () => {
    expect(isAuthorizedMonitorIngest({ authorization: "Bearer right" }, { [MONITOR_INGEST_SECRET_ENV]: "right" })).toBe(true);
  });
});
