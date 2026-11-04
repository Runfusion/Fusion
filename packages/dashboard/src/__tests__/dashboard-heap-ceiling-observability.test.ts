/**
 * RUFU-462 — the V8 heap ceiling becomes an observed fact at every boot surface.
 *
 * The failure this suite encodes: a dashboard can run its whole life under a heap ceiling its operator never
 * chose (here, the ~4.09 GB V8 platform default while the host's launch environment declares 16 GiB), and
 * NOTHING on any surface ever said so. `/api/health` answered `ok` up to the instant of an OOM death, so the
 * condition was only discoverable from the supervisor's restart count. These tests pin the two API surfaces;
 * `lib/__tests__/heap-ceiling.test.ts` pins the classifier and `heap-ceiling-notice.test.ts` pins the boot
 * row, the warning, and the mailbox delivery.
 *
 * Every payload assertion is a HARD number-or-fixed-enum assertion — a `typeof === "number"` stand-in would
 * pass on `undefined`, so each is paired with a positivity/enum-membership check.
 */
// @vitest-environment node

import { EventEmitter } from "node:events";
import { getHeapStatistics } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";
import { formatHeapCeilingLine, getBootHeapCeiling, MAX_OLD_SPACE_FLAG } from "../lib/heap-ceiling.js";
import { resetHeapCeilingBootReportForTesting } from "../heap-ceiling-notice.js";

/** Minimal store double; the health and system-stats routes must answer with the process facts alone. */
class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/repo";
  }
  getFusionDir(): string {
    return "/repo/.fusion";
  }
  // Production-shaped backend seam: server setup probes the async layer and the ChatStore refuses its
  // absence (same double shape as routes/__tests__/metrics-endpoint.test.ts).
  getAsyncLayer = vi.fn(() => ({
    db: {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    },
    healthDb: {},
  }));
  getSettings = vi.fn(async () => this.getSettingsFast());
  getSettingsFast = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getTaskWorkflowSelection = vi.fn(() => undefined);
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  listTasks = vi.fn(async () => []);
  recordRunAuditEvent = vi.fn();
}

function createApp(store: MockStore) {
  return createServer(store as unknown as TaskStore, { noAuth: true });
}

/** `test-request` parses JSON bodies; this helper keeps the raw text available for leak assertions. */
async function getJson(app: ReturnType<typeof createApp>, path: string) {
  const res = await request(app, "GET", path);
  return {
    status: res.status,
    body: res.body as Record<string, any>,
    raw: res.bodyBuffer.toString("utf8"),
  };
}

const HEAP_LIMIT_SOURCES = ["execArgv", "NODE_OPTIONS", "v8-default"] as const;

describe("GET /api/health — heap ceiling is an observed fact", () => {
  it("returns a hard numeric heapLimitBytes equal to the live v8 heap_size_limit", async () => {
    const app = createApp(new MockStore());
    const { status, body } = await getJson(app, "/api/health");

    expect(status).toBe(200);
    expect(typeof body.heapLimitBytes).toBe("number");
    expect(Number.isFinite(body.heapLimitBytes)).toBe(true);
    expect(body.heapLimitBytes).toBeGreaterThan(0);
    expect(body.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
  });

  it("classifies the ceiling source as one of the three fixed values", async () => {
    const app = createApp(new MockStore());
    const { body } = await getJson(app, "/api/health");

    expect(HEAP_LIMIT_SOURCES).toContain(body.heapLimitSource);
    expect(typeof body.heapLimitIsV8Default).toBe("boolean");
    // The flag cannot disagree with the enum it summarizes.
    expect(body.heapLimitIsV8Default).toBe(body.heapLimitSource === "v8-default");
  });

  it("leaks no launch-environment content into the auth-exempt payload", async () => {
    const app = createApp(new MockStore());
    const { raw } = await getJson(app, "/api/health");

    // Whatever this host's NODE_OPTIONS holds (a flag value, a path, or a credential-bearing argument),
    // the payload describes the SITE only.
    const nodeOptions = process.env.NODE_OPTIONS;
    if (nodeOptions) expect(raw).not.toContain(nodeOptions);
    expect(raw).not.toContain(MAX_OLD_SPACE_FLAG);
    expect(raw).not.toMatch(/"NODE_OPTIONS\s*:/);
    expect(String(bodySourceValue(raw))).not.toContain("=");
  });

  it("stays additive: the pre-existing fields keep their shape and status is unaffected by the ceiling", async () => {
    const app = createApp(new MockStore());
    const { body } = await getJson(app, "/api/health");

    // Every field an existing consumer reads is still present with its original type.
    expect(typeof body.status).toBe("string");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.engine?.available).toBe("boolean");
    expect(typeof body.database?.healthy).toBe("boolean");
    expect(body.taskIdIntegrity).toBeDefined();

    // A default (V8-chosen) ceiling is the dangerous case and must NOT flip health: RUFU-462 is observation,
    // not a new health verdict an operator's monitor would page on.
    expect(["ok", "degraded"]).toContain(body.status);
    if (body.database?.healthy && !body.database?.corruptionDetected && body.taskIdIntegrity?.status === "ok" && !body.migration) {
      expect(body.status).toBe("ok");
    }
  });
});

/**
 * The wiring, not the report: `createServer()` is the single call site the CLI boot, the embedded desktop
 * host, and every test share, so a dropped call there would remove the boot-time fact from every real
 * process while all the notice/health unit tests stayed green. Assertions are derived from the live ceiling
 * rather than a fixed launch shape, so the test is honest under a test runner started with or without
 * `--max-old-space-size` in `NODE_OPTIONS`.
 */
describe("createServer() boot wiring — the ceiling is reported once per process", () => {
  it("logs the resolved ceiling on the first server and adds nothing on a second", async () => {
    resetHeapCeilingBootReportForTesting();
    const lines: string[] = [];
    const logger: Record<string, unknown> = {
      scope: "test",
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
      child: () => logger,
    };
    const ceiling = getBootHeapCeiling();

    createServer(new MockStore() as unknown as TaskStore, { noAuth: true, runtimeLogger: logger } as never);
    const afterFirst = lines.length;
    createServer(new MockStore() as unknown as TaskStore, { noAuth: true, runtimeLogger: logger } as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // One info line, byte-identical to the resolver's own rendering of this process's ceiling.
    expect(lines.filter((line) => line === `info ${formatHeapCeilingLine(ceiling)}`)).toHaveLength(1);
    // The warning tracks the classification and nothing else — a declared ceiling never warns.
    expect(lines.filter((line) => line.startsWith("warn "))).toHaveLength(ceiling.isV8Default ? 1 : 0);
    // The second server in the same process reported nothing more (only the 30 ms timer is new here).
    expect(lines).toHaveLength(afterFirst);
  });
});

describe("GET /api/system-stats — the ceiling's source travels with the value", () => {
  it("reports heapLimitSource and heapLimitIsV8Default beside the existing heapLimit", async () => {
    const app = createApp(new MockStore());
    const { status, body, raw } = await getJson(app, "/api/system-stats");

    expect(status).toBe(200);
    const system = body.systemStats as Record<string, any>;

    // The pre-existing field keeps its exact source of truth (v8 heap_size_limit); the new fields describe it.
    expect(system.heapLimit).toBe(getHeapStatistics().heap_size_limit);
    expect(typeof system.heapLimitSource).toBe("string");
    expect(HEAP_LIMIT_SOURCES).toContain(system.heapLimitSource);
    expect(typeof system.heapLimitIsV8Default).toBe("boolean");
    expect(system.heapLimitIsV8Default).toBe(system.heapLimitSource === "v8-default");
    // Both surfaces read the same `heap_size_limit` source, so the number and its provenance cannot drift.
    // The flag string stays out of this payload too, so one rendering rule covers every consumer.
    expect(raw).not.toContain(MAX_OLD_SPACE_FLAG);
  });
});

/** Reads the emitted heapLimitSource out of the raw JSON text (leak assertions work on the wire). */
function bodySourceValue(raw: string): string {
  const match = /"heapLimitSource":"([^"]*)"/.exec(raw);
  return match?.[1] ?? "";
}
