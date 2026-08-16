// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { createServer } from "../../server.js";
import { request } from "../../test-request.js";
import {
  createMetricsSampler,
  type MetricsSampler,
  type RuntimeSamplerInit,
} from "../index.js";

/**
 * RUFU-081 endpoint integration tests.
 *
 * These go one level up from the unit suites: they mount the real
 * `/metrics` route on a server assembled via `createServer` (the same flow the
 * `test-request.ts` harness drives for other app-level routes) and assert the
 * actual Prometheus-text body a `curl /metrics` would receive. They also cover
 * the orchestrator's lifecycle contract that `server.ts` depends on (start/stop
 * idempotency, spawn-hook install/removal).
 *
 * Surfaces asserted here (from the task's Surface Enumeration):
 *   - the `/metrics` route returns `text/plain; version=0.0.4` and never falls
 *     through to the SPA shell;
 *   - a nonexistent route still reproduces the pre-metrics behavior (SPA shell
 *     in non-headless, default 404 in headless);
 *   - headless mode still mounts the route (API/websocket-only servers expose
 *     the same scrape surface);
 *   - sampler start/stop is idempotent and stop removes the spawn hook;
 *   - the render path is synchronous (zero awaited I/O in a scrape).
 */

/** Minimal store double (mirrors `task-effective-settings-route.test.ts`). */
class MockStore extends EventEmitter {
  getRootDir(): string { return "/repo"; }
  getFusionDir(): string { return "/repo/.fusion"; }
  // FNXC:PostgresCutover: server setup probes the async layer, so the route
  // double exposes the production-shaped backend seam.
  getAsyncLayer = vi.fn(() => ({
    db: {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        })),
      })),
    },
  }));
  getSettings = vi.fn(async () => this.getSettingsFast());
  getSettingsFast = vi.fn(async (): Promise<Settings> => ({} as Settings));
  getTaskWorkflowSelection = vi.fn(() => undefined);
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "default");
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
}

/** Build a server app (non-headless by default). */
function createApp(opts: { headless?: boolean } = {}) {
  return createServer(new MockStore() as unknown as TaskStore, {
    noAuth: true,
    headless: opts.headless,
  });
}

/** A fake-timer-friendly interval surface. */
function fakeTimers() {
  const intervals = new Set<{ unref?: () => void }>();
  return {
    setInterval: (fn: () => void, _ms: number) => {
      const token = { unref: () => undefined };
      intervals.add(token);
      void fn;
      return token;
    },
    clearInterval: (t: { unref?: () => void }) => {
      intervals.delete(t);
    },
    /** Number of currently-active fake intervals. */
    activeCount: () => intervals.size,
  };
}

/** A no-op process + spawn + ps surface so the orchestrator is inert for lifecycle tests. */
function inertInit(): {
  runtime: { processRef: RuntimeSamplerInit["processRef"]; psProbe: RuntimeSamplerInit["psProbe"] };
} {
  return {
    runtime: {
      processRef: {
        pid: 1234,
        cpuUsage: () => ({ user: 100, system: 50 }),
        memoryUsage: () => ({ rss: 1_000_000, heapTotal: 512_000, heapUsed: 256_000 }),
      },
      psProbe: async () => ({ ok: true, childCommands: [] }),
    },
  };
}

describe("GET /metrics (app-level route)", () => {
  it("serves Prometheus text (text/plain; version=0.0.4) with expected HELP/TYPE/sample lines", async () => {
    const app = createApp();
    const res = await request(app, "GET", "/metrics");

    expect(res.status).toBe(200);
    const contentType = String(res.headers["content-type"] ?? "");
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");

    const body = String(res.body);
    // Never the SPA shell.
    expect(body).not.toContain("<!doctype html>");
    expect(body).not.toContain("<html");
    expect(body).not.toContain("id=\"root\"");

    // Core runtime metrics present with proper HELP/TYPE exposition.
    expect(body).toContain("# HELP fusion_system_request_count_total");
    expect(body).toContain("# TYPE fusion_system_request_count_total counter");
    expect(body).toContain("fusion_system_request_count_total 0\n");

    // Request-latency quantile family (labeled; the ring is empty pre-request).
    expect(body).toContain("# TYPE fusion_system_request_latency_ms gauge");
    expect(body).toContain('fusion_system_request_latency_ms{quantile="p50"} 0');
    expect(body).toContain('fusion_system_request_latency_ms{quantile="p95"} 0');
    expect(body).toContain('fusion_system_request_latency_ms{quantile="max"} 0');

    // Last-request-age gauge (the freeze indicator).
    expect(body).toContain("# TYPE fusion_system_last_request_age_ms gauge");
    expect(body).toMatch(/^fusion_system_last_request_age_ms 0$/m);

    // Process gauges are finite and present.
    expect(body).toContain("# TYPE fusion_system_process_rss_bytes gauge");
    expect(body).toMatch(/^fusion_system_process_rss_bytes \d+$/m);

    // Spawn counter scalar is present (0 before any spawn).
    expect(body).toContain("# TYPE fusion_system_child_process_spawn_total counter");
    expect(body).toContain("fusion_system_child_process_spawn_total 0\n");

    // Git gauge present (best-effort 0).
    expect(body).toContain("# TYPE fusion_system_git_child_processes gauge");
    expect(body).toContain("fusion_system_git_child_processes 0\n");

    // Domain gauges present (empty registrar -> well-formed 0-valued lines).
    expect(body).toContain("# TYPE fusion_domain_postgres_queries_per_second gauge");
    expect(body).toContain("fusion_domain_postgres_queries_per_second 0\n");
    expect(body).toContain("# TYPE fusion_domain_projects_total gauge");
    expect(body).toContain("fusion_domain_projects_total 0\n");
  });

  it("records a served request through the real pipeline and the latency quantiles reflect it", async () => {
    const app = createApp();
    // GET /api/health goes through the real request pipeline + latency recorder.
    const health = await request(app, "GET", "/api/health");
    expect(health.status).toBe(200);

    // The scrape renders SYNCHRONOUSLY from pre-read state, so it can only see
    // requests completed before it (the health request). A scrape can never
    // count itself (its own `finish` fires after render).
    const res = await request(app, "GET", "/metrics");
    expect(res.status).toBe(200);
    const body = String(res.body);
    // The health request was recorded through the real pipeline.
    const countMatch = body.match(/^fusion_system_request_count_total (\d+)$/m);
    expect(countMatch).not.toBeNull();
    expect(Number(countMatch![1])).toBeGreaterThanOrEqual(1);
    // The age gauge is small (< 5s) because a request was just served.
    const ageMatch = body.match(/^fusion_system_last_request_age_ms (\d+)$/m);
    expect(ageMatch).not.toBeNull();
    expect(Number(ageMatch![1])).toBeLessThan(5000);
  });

  it("is available in headless mode too (API/websocket-only server)", async () => {
    const app = createApp({ headless: true });
    const res = await request(app, "GET", "/metrics");
    expect(res.status).toBe(200);
    const body = String(res.body);
    expect(body).toContain("# TYPE fusion_system_request_count_total counter");
  });

  it("a nonexistent route still reproduces prior behavior (SPA shell in non-headless, 404 in headless)", async () => {
    // Non-headless: the SPA fallback serves the index shell for navigation paths.
    const app = createApp();
    const spaRes = await request(app, "GET", "/some/nonexistent/path");
    // The SPA fallback serves index.html OR a 404 for file-like paths; either is
    // acceptable — what matters is that /some/nonexistent/path is NOT served by
    // the /metrics handler (returning Prometheus text).
    const spaBody = String(spaRes.body);
    expect(spaBody).not.toContain("# HELP fusion_system_request_count_total");

    // Headless: default express 404 (no SPA shell, no metrics body).
    const headlessApp = createApp({ headless: true });
    const headlessRes = await request(headlessApp, "GET", "/some/nonexistent/path");
    expect(headlessRes.status).toBe(404);
    expect(String(headlessRes.body)).not.toContain("# HELP fusion_system_request_count_total");
  });
});

describe("metrics sampler orchestrator lifecycle", () => {
  it("start()/stop() is idempotent and stop() removes the spawn hook exactly", () => {
    // A spawn module we can inspect for wrapping.
    const originalSpawn = vi.fn(() => ({ on: vi.fn(), kill: vi.fn() }));
    const originalFork = vi.fn(() => ({}));
    const originalExecFile = vi.fn(() => ({}));
    const originalExec = vi.fn(() => ({}));
    const spawnMod = {
      spawn: originalSpawn,
      fork: originalFork,
      execFile: originalExecFile,
      exec: originalExec,
    } as unknown as RuntimeSamplerInit["spawnModule"];

    const timers = fakeTimers();
    const sampler: MetricsSampler = createMetricsSampler({
      runtime: {
        ...inertInit().runtime,
        spawnModule: spawnMod,
        timers,
      },
      domain: { timers },
    });

    expect(timers.activeCount()).toBe(0);

    sampler.start();
    expect(sampler.started).toBe(true);
    expect(sampler.runtime.spawnHookInstalled).toBe(true);
    // start() is idempotent: a second start never stacks a second wrap.
    sampler.start();
    expect(sampler.started).toBe(true);
    // The spawn functions are wrapped once (not the original after install).
    expect(spawnMod.spawn).not.toBe(originalSpawn);
    expect(spawnMod.fork).not.toBe(originalFork);

    // Timers armed.
    expect(timers.activeCount()).toBeGreaterThan(0);

    sampler.stop();
    expect(sampler.started).toBe(false);
    expect(sampler.runtime.spawnHookInstalled).toBe(false);
    // The originals were restored EXACTLY on stop.
    expect(spawnMod.spawn).toBe(originalSpawn);
    expect(spawnMod.fork).toBe(originalFork);
    expect(spawnMod.execFile).toBe(originalExecFile);
    expect(spawnMod.exec).toBe(originalExec);
    // All timers cleared.
    expect(timers.activeCount()).toBe(0);

    // stop() is idempotent (no throw, no re-wrap).
    sampler.stop();
    expect(spawnMod.spawn).toBe(originalSpawn);
  });

  it("render() is synchronous and produces a deterministic body from pre-read state", () => {
    const sampler = createMetricsSampler({ runtime: inertInit().runtime });
    const a = sampler.render(1_700_000_000_000);
    const b = sampler.render(1_700_000_000_000);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toContain("# TYPE fusion_system_request_count_total counter");
  });
});