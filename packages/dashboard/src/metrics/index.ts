/**
 * RUFU-081 combined `/metrics` observability surface.
 *
 * Single import point for the Prometheus-text serializer and the runtime /
 * domain samplers that feed the dashboard `/metrics` endpoint. The orchestrator
 * ({@link createMetricsSampler}) is what `server.ts` mounts; the lower-level
 * modules are re-exported for tests and future samplers.
 */
export { serializeMetrics } from "./prometheus-text.js";
export type { MetricSample, MetricFamily, MetricsSnapshot } from "./prometheus-text.js";

export { createMetricsSampler } from "./sampler.js";
export type { MetricsSampler, MetricsSamplerInit } from "./sampler.js";

export {
  createRuntimeSampler,
  createRequestLatencyMiddleware,
  recordRequest,
  defaultPsProbe,
  REQUEST_LATENCY_RING_CAP,
  DEFAULT_LATENCY_BUCKETS_MS,
} from "./runtime-sampler.js";
export type {
  RuntimeSampler,
  RuntimeSamplerInit,
  LatencyRecorderState,
  SpawnCounts,
  ProcessLike,
  PsProbe,
} from "./runtime-sampler.js";

export { createDomainSampler, defaultPgStatsReader } from "./domain-sampler.js";
export type {
  DomainSampler,
  DomainSamplerInit,
  DomainSamplerState,
  PgStats,
  PgStatsReader,
} from "./domain-sampler.js";