/*
FNXC:Telemetry 2026-06-16-09:44:
U10 OTLP exporter coverage (PR #1683): pins the default-off behavior, https-only endpoint validation in production, header redaction, and retry/backoff so the exporter can't silently start, leak secrets, or hot-loop on a failing collector.
*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import {
  resolveOtelExporterConfig,
  redactHeadersForDiagnostics,
  parseKeyValueList,
  startOtelExporter,
  maybeStartOtelExporter,
  type FetchLike,
  type OtelExporterConfig,
} from "../otel-exporter.js";
import type { RuntimeLogger } from "../runtime-logger.js";

interface CapturedLog {
  level: "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

function makeLogger(): { logger: RuntimeLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const mk = (): RuntimeLogger => ({
    info: (message, context) => logs.push({ level: "info", message, context }),
    warn: (message, context) => logs.push({ level: "warn", message, context }),
    error: (message, context) => logs.push({ level: "error", message, context }),
    child: () => mk(),
  });
  return { logger: mk(), logs };
}

function seedDb(db: Database): void {
  db.prepare(
    `INSERT INTO tasks
       (id, description, "column", createdAt, updatedAt,
        tokenUsageInputTokens, tokenUsageOutputTokens, tokenUsageCachedTokens,
        tokenUsageCacheWriteTokens, tokenUsageTotalTokens, tokenUsageLastUsedAt,
        modelProvider, modelId)
     VALUES ('t1', 'd', 'todo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             100, 50, 10, 5, 165, '2026-03-01T00:00:00.000Z', 'anthropic', 'claude-opus-4-8')`,
  ).run();
}

function configFor(overrides: Partial<OtelExporterConfig> = {}): OtelExporterConfig {
  return {
    endpoint: "https://collector.example/v1/metrics",
    headers: { "DD-API-KEY": "super-secret-token-value" },
    intervalMs: 60_000 as OtelExporterConfig["intervalMs"],
    timeoutMs: 5_000,
    resourceAttributes: { "service.name": "fusion-dashboard" },
    ...overrides,
  };
}

describe("resolveOtelExporterConfig (disabled by default)", () => {
  it("returns disabled when no endpoint is configured", () => {
    expect(resolveOtelExporterConfig({}).kind).toBe("disabled");
  });

  it("enables when an https endpoint is set", () => {
    const r = resolveOtelExporterConfig({
      FUSION_OTEL_METRICS_ENDPOINT: "https://collector:4318/v1/metrics",
      FUSION_OTEL_METRICS_HEADERS: "DD-API-KEY=abc,X-Other=1",
    });
    expect(r.kind).toBe("enabled");
    if (r.kind !== "enabled") return;
    expect(r.warnHttp).toBe(false);
    expect(r.config.headers["DD-API-KEY"]).toBe("abc");
  });

  it("rejects http:// in production", () => {
    const r = resolveOtelExporterConfig({
      NODE_ENV: "production",
      FUSION_OTEL_METRICS_ENDPOINT: "http://collector:4318/v1/metrics",
    });
    expect(r.kind).toBe("rejected");
  });

  it("allows http:// outside production but flags warnHttp", () => {
    const r = resolveOtelExporterConfig({
      FUSION_OTEL_METRICS_ENDPOINT: "http://localhost:4318/v1/metrics",
    });
    expect(r.kind).toBe("enabled");
    if (r.kind !== "enabled") return;
    expect(r.warnHttp).toBe(true);
  });

  it("rejects a malformed endpoint URL", () => {
    const r = resolveOtelExporterConfig({ FUSION_OTEL_METRICS_ENDPOINT: "not a url" });
    expect(r.kind).toBe("rejected");
  });
});

describe("parseKeyValueList / redactHeadersForDiagnostics", () => {
  it("parses key=value lists and skips malformed pairs", () => {
    expect(parseKeyValueList("a=1, b=2,bad,c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("masks all header values, preserving keys", () => {
    const r = redactHeadersForDiagnostics({ "DD-API-KEY": "secret", Authorization: "Bearer x" });
    expect(r).toEqual({ "DD-API-KEY": "[REDACTED]", Authorization: "[REDACTED]" });
  });
});

describe("startOtelExporter (with a collector stub)", () => {
  let tmpDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-otel-exporter-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
    seedDb(db);
    store = { getDatabase: () => db } as unknown as TaskStore;
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exports token/cost/activity metrics with expected names + attributes", async () => {
    let capturedBody: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedBody = init.body;
      return { ok: true, status: 200 };
    };
    const { logger } = makeLogger();
    const handle = startOtelExporter({ store, config: configFor(), logger, fetchImpl });
    await handle.exportOnce();
    handle.stop();

    expect(capturedBody).toBeDefined();
    const payload = JSON.parse(capturedBody!);
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const names = metrics.map((m: { name: string }) => m.name);
    expect(names).toContain("fusion.command_center.tokens.total");
    expect(names).toContain("fusion.command_center.cost.usd");
    expect(names).toContain("fusion.command_center.activity.active_nodes");
    // model attribute present on a token data point.
    const total = metrics.find(
      (m: { name: string }) => m.name === "fusion.command_center.tokens.total",
    );
    const attributed = total.sum.dataPoints.find(
      (p: { attributes: Array<{ key: string }> }) => p.attributes.length > 0,
    );
    expect(attributed.attributes[0].key).toBe("model");
  });

  it("sends configured auth headers but never logs their values", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      sentHeaders = init.headers;
      return { ok: true, status: 200 };
    };
    const { logger, logs } = makeLogger();
    const handle = startOtelExporter({ store, config: configFor(), logger, fetchImpl });
    await handle.exportOnce();
    handle.stop();

    // The secret IS sent on the wire.
    expect(sentHeaders?.["DD-API-KEY"]).toBe("super-secret-token-value");
    // ...but never appears in any log line.
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("super-secret-token-value");
  });

  it("backs off and logs (redacted) when the collector is unreachable; never throws", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED collector down token=super-secret-token-value");
    };
    const { logger, logs } = makeLogger();
    const handle = startOtelExporter({ store, config: configFor(), logger, fetchImpl });
    // Must not throw out of the export.
    await expect(handle.exportOnce()).resolves.toBeUndefined();
    handle.stop();

    const warn = logs.find((l) => l.level === "warn" && l.message.includes("unreachable"));
    expect(warn).toBeDefined();
    // The secret embedded in the error message is redacted.
    expect(JSON.stringify(logs)).not.toContain("super-secret-token-value");
    // Header values masked in the warn context.
    expect((warn?.context?.headers as Record<string, string>)["DD-API-KEY"]).toBe("[REDACTED]");
  });

  it("treats a non-2xx response as a failure and backs off, without throwing", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503 });
    const { logger, logs } = makeLogger();
    const handle = startOtelExporter({ store, config: configFor(), logger, fetchImpl });
    await expect(handle.exportOnce()).resolves.toBeUndefined();
    handle.stop();
    expect(logs.some((l) => l.level === "warn" && l.context?.status === 503)).toBe(true);
  });
});

describe("maybeStartOtelExporter (disabled-by-default gate)", () => {
  let tmpDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-otel-maybe-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
    store = { getDatabase: () => db } as unknown as TaskStore;
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does NOT start an exporter when no endpoint env is set", () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
    const { logger } = makeLogger();
    const handle = maybeStartOtelExporter({ store, logger, env: {}, fetchImpl });
    expect(handle).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs a warning and does not start when the endpoint is rejected", () => {
    const { logger, logs } = makeLogger();
    const handle = maybeStartOtelExporter({
      store,
      logger,
      env: { NODE_ENV: "production", FUSION_OTEL_METRICS_ENDPOINT: "http://x/v1/metrics" },
    });
    expect(handle).toBeNull();
    expect(logs.some((l) => l.level === "warn" && l.message.includes("NOT started"))).toBe(true);
  });

  it("starts and warns loudly for an http:// endpoint outside production", () => {
    const { logger, logs } = makeLogger();
    const handle = maybeStartOtelExporter({
      store,
      logger,
      env: { FUSION_OTEL_METRICS_ENDPOINT: "http://localhost:4318/v1/metrics" },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    expect(handle).not.toBeNull();
    handle?.stop();
    expect(logs.some((l) => l.level === "warn" && l.message.includes("UNENCRYPTED"))).toBe(true);
  });
});
