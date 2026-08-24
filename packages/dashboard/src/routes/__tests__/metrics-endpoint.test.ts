// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskStore } from "@fusion/core";
import { assertExpositionText, indexFamilies, requireFamily } from "../../__tests__/prometheus-text-parse.js";
import { createServer } from "../../server.js";
import { request } from "../../test-request.js";

/*
FNXC:PrometheusAcceptance 2026-08-13-16:45:
RUFU-082 endpoint acceptance: the served /metrics body must be proven well-formed
Prometheus exposition text that covers all five measurement gaps RUFU-081
introduced (event-loop/health latency, spawn cadence, PG query rate, git gauge,
CPU/memory/RSS) and must NOT be the SPA index.html fallback that /metrics used to
serve. A scrape must stay store-free (no run-audit prose writes) and repeat scrapes
must render a fresh, bounded snapshot. Assertions bind to RUFU-081's actual metric
family names, never assumed ones.
*/

/**
 * RUFU-082 endpoint acceptance suite for the `/metrics` observability route.
 *
 * RUFU-081 implemented and serialized this route; RUFU-082 is the acceptance
 * grammar that proves the served body is REAL Prometheus exposition text — and
 * that the ORIGINAL bug class is gone: `GET /metrics` used to fall through to
 * the SPA shell and serve `index.html`. These tests parse the served body with
 * an independent exposition-text parser (see `../../__tests__/prometheus-text-parse.ts`)
 * and assert, per family, the five diagnosis gaps the RUFU-081 contract
 * enumerates, plus the no-run-audit-prose and repeat-scrape-stability seams.
 *
 * Because the sampler is created inside `createServer` and only observable via
 * the route, this suite drives the app the same way a `curl /metrics` scrape
 * would — through the real request pipeline via `test-request.ts`. No
 * production DB queries, no polling, no real network.
 *
 * Five measurement gaps asserted here:
 *   1. event-loop/health latency     -> fusion_system_request_latency_ms /
 *                                        fusion_system_last_request_age_ms
 *   2. child-process spawn count     -> fusion_system_child_process_spawn_total
 *   3. PostgreSQL query rate         -> fusion_domain_postgres_queries_per_second
 *   4. git subprocess gauge          -> fusion_system_git_child_processes
 *   5. engine CPU / memory / RSS     -> fusion_system_cpu_{user,system}_seconds_total /
 *                                        fusion_system_process_{rss,heap_*}_bytes
 */

/** Minimal store double (mirrors the app-level route test fixtures). */
class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/repo";
  }
  getFusionDir(): string {
    return "/repo/.fusion";
  }
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
  // The run-audit write seam. A scrape must NEVER write metric prose/content
  // here (FN-7158/FN-7528); the test asserts this spy is untouched during a
  // GET /metrics/N.
  recordRunAuditEvent = vi.fn();
}

function createApp(store: MockStore) {
  return createServer(store as unknown as TaskStore, { noAuth: true });
}

describe("GET /metrics (RUFU-082 acceptance)", () => {
  it("serves parseable Prometheus exposition text, not the SPA index.html fallback", async () => {
    const app = createApp(new MockStore());
    const res = await request(app, "GET", "/metrics");

    expect(res.status).toBe(200);
    const contentType = String(res.headers["content-type"] ?? "");
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");

    const body = String(res.body);
    // The original bug class: this path used to fall through to the SPA shell.
    expect(body).not.toContain("<!doctype html>");
    expect(body).not.toContain("<html");
    expect(body).not.toContain('id="root"');

    // Independent grammar proves it is well-formed exposition text.
    const parsed = assertExpositionText(body);
    expect(parsed.families.length).toBeGreaterThan(0);
  });

  it.each([
    ["event-loop/health latency", "fusion_system_request_latency_ms"],
    ["event-loop/health freeze indicator", "fusion_system_last_request_age_ms"],
    ["child-process spawn count", "fusion_system_child_process_spawn_total"],
    ["postgresql query rate", "fusion_domain_postgres_queries_per_second"],
    ["git subprocess gauge", "fusion_system_git_child_processes"],
    ["engine CPU (user seconds)", "fusion_system_cpu_user_seconds_total"],
    ["engine process RSS", "fusion_system_process_rss_bytes"],
    ["engine heap used", "fusion_system_process_heap_used_bytes"],
  ])("exposes the %s measurement gap as a parseable family", async (_label, familyName) => {
    const app = createApp(new MockStore());
    const res = await request(app, "GET", "/metrics");
    expect(res.status).toBe(200);
    const parsed = assertExpositionText(String(res.body));
    const family = requireFamily(parsed, familyName);
    // A family must be present and its scalar (no-label) value a finite number
    // in the fresh-process empty state (the serializer coerces NaN/Inf to 0).
    expect(family.samples.length).toBeGreaterThan(0);
    const value = family.samples[0].value;
    expect(Number.isFinite(value)).toBe(true);
  });

  it("ties the event-loop latency family to the LIVE serving path (a real request moves the gauges)", async () => {
    const app = createApp(new MockStore());
    // A real request through the pipeline (the health route) must be recorded
    // by the latency middleware and reflected in the next scrape.
    const health = await request(app, "GET", "/api/health");
    expect(health.status).toBe(200);

    const res = await request(app, "GET", "/metrics");
    const parsed = assertExpositionText(String(res.body));
    const index = indexFamilies(parsed);

    const count = requireFamily(parsed, "fusion_system_request_count_total").samples[0].value;
    expect(count).toBeGreaterThanOrEqual(1);

    // The last-request-age freeze indicator reflects the just-served request
    // (a small, finite number) rather than the pre-request 0.
    const age = requireFamily(parsed, "fusion_system_last_request_age_ms").samples[0].value;
    expect(Number.isFinite(age)).toBe(true);
    expect(age).toBeLessThan(5000);

    // The latency quantile family exposes the labeled p50/p95/max quantiles.
    const latency = index.get("fusion_system_request_latency_ms");
    expect(latency).toBeDefined();
    const quantiles = Object.fromEntries(
      latency!.samples.map((s) => [s.labels[0]?.value, s.value]),
    );
    for (const q of ["p50", "p95", "max"]) {
      expect(quantiles).toHaveProperty(q);
      expect(Number.isFinite(quantiles[q])).toBe(true);
    }
  });

  it("writes no run-audit row (metric prose/content) during a scrape", async () => {
    const store = new MockStore();
    const app = createApp(store);
    // A first request warms server construction (some setup paths touch the
    // store); then we care only about the scrape itself being store-free.
    await request(app, "GET", "/api/health");
    store.recordRunAuditEvent.mockClear();

    const res = await request(app, "GET", "/metrics");
    expect(res.status).toBe(200);
    const body = String(res.body);
    // The scrape is a pure synchronous render from pre-read gauges; it must
    // never emit audit rows. This guards the FN-7158/FN-7528 "no prose in
    // run-audit" invariant and that metric values are numeric-only.
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
    // The body itself must be numeric gauges only — no JSON/text prose lines.
    const parsed = assertExpositionText(body);
    for (const sample of parsed.samples) {
      expect(typeof sample.value).toBe("number");
    }
  });

  it("a second immediate scrape is fresh/parseable with a stable, bounded family count", async () => {
    const app = createApp(new MockStore());
    const first = await request(app, "GET", "/metrics");
    const parsedFirst = assertExpositionText(String(first.body));
    const familyCountFirst = parsedFirst.families.length;

    // A second immediate scrape must not pile up ever-growing per-scrape series
    // (each render is a fresh snapshot from bounded pre-read state).
    const second = await request(app, "GET", "/metrics");
    const parsedSecond = assertExpositionText(String(second.body));
    expect(parsedSecond.families.length).toBe(familyCountFirst);

    // The per-family sample counts stay identical too (same set, same sizes).
    const shapeFirst = parsedFirst.families.map((f) => [f.name, f.samples.length]);
    const shapeSecond = parsedSecond.families.map((f) => [f.name, f.samples.length]);
    expect(shapeSecond).toEqual(shapeFirst);
  });

  it("does not confuse an adjacent path that serves non-metric content (fallback guard)", async () => {
    const app = createApp(new MockStore());
    // A navigation path we did not turn into a metrics route must still be
    // served by the SPA fallback (index shell) and NOT by the /metrics handler.
    const spaRes = await request(app, "GET", "/some/navigation/path");
    const spaBody = String(spaRes.body);
    // The SPA fallback serves the shell (an HTML boot page) for navigation
    // paths — in test mode that is a "temporarily unavailable" boot page rather
    // than a static index.html. What matters is it is NOT Prometheus text.
    expect(spaBody).not.toContain("# TYPE fusion_system_request_count_total");
    expect(spaBody).not.toContain("# HELP fusion_system_request_count_total");
    expect(spaBody).not.toContain("text/plain; version=0.0.4");

    // The real /metrics route is unaffected and still parses.
    const metricsRes = await request(app, "GET", "/metrics");
    expect(metricsRes.status).toBe(200);
    assertExpositionText(String(metricsRes.body));
  });

  it("empty-state (fresh process) renders well-formed zero/NaN-coerced scalar families", async () => {
    const app = createApp(new MockStore());
    const parsed = assertExpositionText(String((await request(app, "GET", "/metrics")).body));
    // Fresh process: PG rate is 0 (no prior delta), git gauge 0, spawn count 0.
    expect(requireFamily(parsed, "fusion_domain_postgres_queries_per_second").samples[0].value).toBe(0);
    expect(requireFamily(parsed, "fusion_system_git_child_processes").samples[0].value).toBe(0);
    expect(requireFamily(parsed, "fusion_system_child_process_spawn_total").samples[0].value).toBe(0);
    // The labeled per-kind spawn family is absent when nothing spawned (the
    // serializer omits an empty-samples labeled family), which is well-formed.
    expect(indexFamilies(parsed).has("fusion_system_child_process_spawn_total_by_kind")).toBe(false);
  });
});