// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AsyncDataLayer, Settings, TaskStore } from "@fusion/core";

/*
Route-level contract lock for RUFU-302: the published `database` health object
carries ONLY measured fields, so no future store-snapshot member can leak onto
the wire the way the always-false `isRunning` probe-in-progress flag once did.
Assertions bind to the served JSON over BOTH published routes, not to the
`buildHealthPayload` return value — the pair-invariant test already covers the
pure function, and only the served body proves the seam cannot reopen.
*/

const healthMocks = vi.hoisted(() => ({
  checkPostgresHealth: vi.fn(),
  detectTaskIdIntegrityAnomaliesAsync: vi.fn(),
  getSqliteMigrationState: vi.fn(),
}));

// Spread @fusion/core (it also exports `isRunning`) and override only the three
// functions the health evaluator awaits, so connectivity vs. healthy states are
// driven deterministically without a real database.
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  checkPostgresHealth: healthMocks.checkPostgresHealth,
  detectTaskIdIntegrityAnomaliesAsync: healthMocks.detectTaskIdIntegrityAnomaliesAsync,
  getSqliteMigrationState: healthMocks.getSqliteMigrationState,
}));

const { createServer } = await import("../../server.js");
const { request } = await import("../../test-request.js");

/** The exact published key set RUFU-302 locks. Any added/removed key fails. */
const PUBLISHED_DATABASE_KEYS = [
  "corruptionDetected",
  "corruptionErrors",
  "healthy",
  "lastCheckedAt",
];

/** A healthy measurement: connectivity probe clean, integrity clean, no migration marker. */
function mockHealthy(): void {
  healthMocks.checkPostgresHealth.mockResolvedValue([]);
  healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockResolvedValue({
    status: "ok",
    checkedAt: "2026-10-15T13:28:00.000Z",
    anomalies: [],
  });
  healthMocks.getSqliteMigrationState.mockResolvedValue(null);
}

/**
 * A dead backend: `checkPostgresHealth` RESOLVES a non-empty verdict list (its
 * real contract) rather than rejecting, which the evaluator classifies as an
 * `unreachable` connectivity failure and surfaces as degraded health.
 */
function mockUnreachable(): void {
  healthMocks.checkPostgresHealth.mockResolvedValue([
    "PostgreSQL backend unreachable: connect ECONNREFUSED 127.0.0.1:5432",
  ]);
  healthMocks.detectTaskIdIntegrityAnomaliesAsync.mockResolvedValue({
    status: "ok",
    checkedAt: "2026-10-15T13:28:00.000Z",
    anomalies: [],
  });
  healthMocks.getSqliteMigrationState.mockResolvedValue(null);
}

/** Minimal store double (mirrors the app-level route test fixtures). */
class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/repo";
  }
  getFusionDir(): string {
    return "/repo/.fusion";
  }
  getAsyncLayer = vi.fn(
    () =>
      ({
        db: {
          update: vi.fn(() => ({
            set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
          })),
        },
        healthDb: {},
      }) as unknown as AsyncDataLayer,
  );
  getSettings = vi.fn(async () => this.getSettingsFast());
  getSettingsFast = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getTaskWorkflowSelection = vi.fn(() => undefined);
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  recordRunAuditEvent = vi.fn();
}

function createApp(store: MockStore) {
  return createServer(store as unknown as TaskStore, { noAuth: true });
}

describe("published health payload database contract (RUFU-302)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const [label, route] of [
    ["GET /api/health", { method: "GET", path: "/api/health" }],
    ["POST /api/health/refresh", { method: "POST", path: "/api/health/refresh" }],
  ] as const) {
    describe(label, () => {
      it("publishes exactly the measured database key set when healthy", async () => {
        mockHealthy();
        const res = await request(createApp(new MockStore()), route.method, route.path);

        expect(res.status).toBe(200);
        const body = res.body as { status: string; database: Record<string, unknown> };
        expect(body.status).toBe("ok");
        // Closed key set — the strongest lock against a future store member leaking.
        expect(Object.keys(body.database).sort()).toEqual(PUBLISHED_DATABASE_KEYS);
        expect(body.database).not.toHaveProperty("isRunning");
      });

      it("keeps the same closed key set when the database is unreachable", async () => {
        mockUnreachable();
        const res = await request(createApp(new MockStore()), route.method, route.path);

        expect(res.status).toBe(200);
        const body = res.body as { status: string; database: Record<string, unknown> };
        expect(body.status).toBe("degraded");
        // The unreachable state really reached the probe (we mocked the real seam).
        expect(healthMocks.checkPostgresHealth).toHaveBeenCalled();
        expect(body.database).not.toHaveProperty("isRunning");
        expect(Object.keys(body.database).sort()).toEqual(PUBLISHED_DATABASE_KEYS);
      });
    });
  }
});
