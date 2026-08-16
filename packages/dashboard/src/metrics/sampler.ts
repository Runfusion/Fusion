/**
 * RUFU-081 sampler orchestrator for the dashboard `/metrics` endpoint.
 *
 * Composes the runtime sampler (request-latency recorder, process CPU/memory,
 * spawn-count hook, git-subprocess gauge) and the domain sampler (PostgreSQL
 * query rate + project/agent/board-column gauges) behind one handle:
 *
 *   - `start()`  — installs the spawn-count hook once and starts both samplers'
 *                  unref'd tick timers (runtime ~5s, process ~5s, git ~15s,
 *                  PG ~5s, domain ~5s). Idempotent: a second `start()` after the
 *                  first is a no-op and never stacks a second wrap of
 *                  `child_process`.
 *   - `stop()`   — clears all timers and removes the spawn hook, exactly
 *                  restoring the original `child_process` functions.
 *   - `render()` — assembles the Prometheus text body SYNCHRONOUSLY from the
 *                  pre-read gauge snapshot (zero awaited I/O in the render
 *                  path, so a scrape can never starve the event loop).
 *   - `middleware()` — the latency-recorder head for `app.use(...)`, mounted
 *                      before route handlers so it times the LIVE HTTP serving
 *                      path (including `GET /api/health`).
 *
 * No GitHub push, no publish/release/tag commands are ever run by this module.
 * Metric values are numeric gauges only; nothing here writes metric content or
 * numeric snapshots into the run-audit (FN-7158/FN-7528).
 */

import type { MetricFamily } from "./prometheus-text.js";
import { serializeMetrics } from "./prometheus-text.js";
import {
  createRuntimeSampler,
  createRequestLatencyMiddleware,
  type RuntimeSampler,
  type RuntimeSamplerInit,
} from "./runtime-sampler.js";
import { createDomainSampler, type DomainSampler, type DomainSamplerInit } from "./domain-sampler.js";

/** The orchestrator's public handle. */
export interface MetricsSampler {
  readonly runtime: RuntimeSampler;
  readonly domain: DomainSampler;
  /** True while the sampler timers + spawn hook are active. */
  readonly started: boolean;
  /**
   * The Express latency-recorder head. Mount with `app.use(...)` before route
   * handlers; it records every served request into the shared ring.
   */
  middleware(): (req: unknown, res: unknown, next?: () => void) => void;
  /** Install the spawn hook once + start all tick timers (idempotent). */
  start(): void;
  /** Clear all timers and remove the spawn hook (idempotent). */
  stop(): void;
  /** Render the Prometheus text body synchronously from pre-read state. */
  render(nowMs?: number): string;
}

/** Constructor options; both sampler configs are fully injectable for tests. */
export interface MetricsSamplerInit {
  runtime?: RuntimeSamplerInit;
  domain?: DomainSamplerInit;
}

/** Create an orchestrator. No side effects until {@link MetricsSampler.start}. */
export function createMetricsSampler(init: MetricsSamplerInit = {}): MetricsSampler {
  const runtime = createRuntimeSampler(init.runtime);
  const domain = createDomainSampler(init.domain);
  let started = false;

  function start(): void {
    if (started) return;
    started = true;
    // installSpawnHook is itself idempotent; start once so a repeat start never
    // stacks a second wrapper over child_process.
    runtime.installSpawnHook();
    runtime.start();
    domain.start();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    runtime.stopTimers();
    domain.stopTimers();
    runtime.removeSpawnHook();
  }

  function render(nowMs?: number): string {
    // Synchronous render from pre-read gauges only — no awaits here.
    const now = nowMs ?? Date.now();
    const families: MetricFamily[] = [...runtime.buildSnapshot(now), ...domain.buildSnapshot(now)];
    return serializeMetrics({ families });
  }

  return {
    runtime,
    domain,
    get started() {
      return started;
    },
    middleware: () => createRequestLatencyMiddleware(runtime.latency),
    start,
    stop,
    render,
  };
}