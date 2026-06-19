/**
 * OpenTelemetry (OTLP) metric mapping (U10).
 *
 * Pure mapping of the Command Center aggregator outputs (tokens / cost / activity)
 * to OTLP metric instruments. This module produces the **OTLP/HTTP JSON wire
 * shape** (`{ resourceMetrics: [...] }`) directly — the exact body an OTLP/HTTP
 * collector accepts at `/v1/metrics` — so it is testable without a live collector
 * and without pulling the full `@opentelemetry/*` SDK into `@fusion/core`.
 *
 * Design (KTD2): the MAPPING lives in core (reusable, side-effect-free); the
 * network export (endpoint validation, auth headers, periodic scheduling, back
 * off) lives in the dashboard exporter. This module never reads the clock, the
 * network, or env — callers pass an explicit `timeUnixNano`.
 *
 * Instrument choices:
 *  - Token counts and USD cost are **monotonic counters** (`Sum`, cumulative,
 *    monotonic) — they only grow over a fixed range and aggregate cleanly.
 *  - Activity "current state" figures (active nodes/agents, sessions, stickiness)
 *    are **gauges** — point-in-time values that should not be summed across
 *    series.
 *
 * Attributes (model / provider / node / agent) are attached per data point from
 * the aggregator's group keys, so a collector can break metrics down by any of
 * them. We emit one data point per group plus an unattributed grand-total point.
 */

import type { TokenAnalytics } from "./token-analytics.js";
import type { ActivityAnalytics } from "./activity-analytics.js";

/** Instrument namespace prefix for every metric this module emits. */
export const OTEL_METRIC_PREFIX = "fusion.command_center";

/** A single OTLP attribute key/value (string-valued; numbers are stringified). */
export interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

/** An OTLP number data point (used for both Sum and Gauge). */
export interface OtlpNumberDataPoint {
  /** Group attributes (model/provider/node/agent), empty for grand totals. */
  attributes: OtlpAttribute[];
  /** Nanoseconds since epoch; the start of the measurement window. */
  startTimeUnixNano: string;
  /** Nanoseconds since epoch; when the value was observed. */
  timeUnixNano: string;
  /** Integer counts use asInt; fractional values (cost, ratios) use asDouble. */
  asInt?: string;
  asDouble?: number;
}

/** An OTLP metric (one instrument), either a Sum (counter) or a Gauge. */
export interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  sum?: {
    dataPoints: OtlpNumberDataPoint[];
    /** 2 = CUMULATIVE in the OTLP AggregationTemporality enum. */
    aggregationTemporality: 2;
    isMonotonic: boolean;
  };
  gauge?: {
    dataPoints: OtlpNumberDataPoint[];
  };
}

/** The OTLP/HTTP JSON export envelope sent to a collector's `/v1/metrics`. */
export interface OtlpExportPayload {
  resourceMetrics: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

/** Inputs to {@link mapAnalyticsToOtlp}. */
export interface OtelMappingInput {
  tokens: TokenAnalytics;
  activity: ActivityAnalytics;
  /** Observation time in nanoseconds since the Unix epoch (caller-supplied). */
  timeUnixNano: string;
  /**
   * Start of the measurement window in nanoseconds since the Unix epoch. Used
   * for the Sum start time so a collector treats the counters as a fresh
   * cumulative series. Defaults to {@link OtelMappingInput.timeUnixNano}.
   */
  startTimeUnixNano?: string;
  /**
   * Resource attributes describing the emitting service (e.g.
   * `{ "service.name": "fusion-dashboard" }`). Defaults to a minimal
   * `service.name`.
   */
  resourceAttributes?: Record<string, string>;
  /** OTLP scope (instrumentation library) version. Defaults to `"1"`. */
  scopeVersion?: string;
}

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function toAttributes(record: Record<string, string>): OtlpAttribute[] {
  return Object.entries(record).map(([k, v]) => attr(k, v));
}

function intPoint(
  value: number,
  attributes: OtlpAttribute[],
  startTimeUnixNano: string,
  timeUnixNano: string,
): OtlpNumberDataPoint {
  return {
    attributes,
    startTimeUnixNano,
    timeUnixNano,
    // OTLP ints are wire-encoded as strings. Coerce non-finite/negative to 0.
    asInt: String(Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0))),
  };
}

function doublePoint(
  value: number,
  attributes: OtlpAttribute[],
  startTimeUnixNano: string,
  timeUnixNano: string,
): OtlpNumberDataPoint {
  return {
    attributes,
    startTimeUnixNano,
    timeUnixNano,
    asDouble: Number.isFinite(value) ? value : 0,
  };
}

function counter(
  name: string,
  description: string,
  unit: string,
  dataPoints: OtlpNumberDataPoint[],
): OtlpMetric {
  return {
    name,
    description,
    unit,
    sum: { dataPoints, aggregationTemporality: 2, isMonotonic: true },
  };
}

function gauge(
  name: string,
  description: string,
  unit: string,
  dataPoints: OtlpNumberDataPoint[],
): OtlpMetric {
  return { name, description, unit, gauge: { dataPoints } };
}

/**
 * Attributes for a token group. The grouped dimension is reflected by the key
 * the aggregator chose (`groupBy`); we tag it with the matching attribute name
 * so a collector sees `model` / `provider` / `node.id` / `agent.id`.
 */
function groupAttributes(
  groupBy: TokenAnalytics["groupBy"],
  key: string | null,
): OtlpAttribute[] {
  if (!groupBy || key === null) return [];
  switch (groupBy) {
    case "model":
      return [attr("model", key)];
    case "provider":
      return [attr("provider", key)];
    case "node":
      return [attr("node.id", key)];
    case "agent":
      return [attr("agent.id", key)];
  }
}

/**
 * Map token + activity analytics to an OTLP/HTTP JSON export payload.
 *
 * Token/cost metrics emit one data point per group (carrying the group's
 * model/provider/node/agent attribute) plus an unattributed grand-total point.
 * Cost is omitted from a data point when `cost.usd` is null (unpriced models) so
 * an unavailable cost never reports as `$0`. Activity metrics are gauges with no
 * group attributes (the activity aggregator is range-scoped, not grouped).
 *
 * Pure: no I/O, no clock. Returns a fresh payload every call.
 */
export function mapAnalyticsToOtlp(input: OtelMappingInput): OtlpExportPayload {
  const { tokens, activity, timeUnixNano } = input;
  const start = input.startTimeUnixNano ?? timeUnixNano;
  const resourceAttributes = input.resourceAttributes ?? {
    "service.name": "fusion-dashboard",
  };
  const scopeVersion = input.scopeVersion ?? "1";

  const p = OTEL_METRIC_PREFIX;

  // ── Token counters (one data point per group + a grand total) ──────────
  const inputTokenPoints: OtlpNumberDataPoint[] = [];
  const outputTokenPoints: OtlpNumberDataPoint[] = [];
  const cachedTokenPoints: OtlpNumberDataPoint[] = [];
  const totalTokenPoints: OtlpNumberDataPoint[] = [];
  const costPoints: OtlpNumberDataPoint[] = [];

  // Grand totals (unattributed).
  inputTokenPoints.push(intPoint(tokens.totals.inputTokens, [], start, timeUnixNano));
  outputTokenPoints.push(intPoint(tokens.totals.outputTokens, [], start, timeUnixNano));
  cachedTokenPoints.push(intPoint(tokens.totals.cachedTokens, [], start, timeUnixNano));
  totalTokenPoints.push(intPoint(tokens.totals.totalTokens, [], start, timeUnixNano));
  if (tokens.cost.usd !== null) {
    costPoints.push(doublePoint(tokens.cost.usd, [], start, timeUnixNano));
  }

  // Per-group points.
  for (const group of tokens.groups) {
    const attrs = groupAttributes(tokens.groupBy, group.key);
    inputTokenPoints.push(intPoint(group.inputTokens, attrs, start, timeUnixNano));
    outputTokenPoints.push(intPoint(group.outputTokens, attrs, start, timeUnixNano));
    cachedTokenPoints.push(intPoint(group.cachedTokens, attrs, start, timeUnixNano));
    totalTokenPoints.push(intPoint(group.totalTokens, attrs, start, timeUnixNano));
    if (group.cost.usd !== null) {
      costPoints.push(doublePoint(group.cost.usd, attrs, start, timeUnixNano));
    }
  }

  const metrics: OtlpMetric[] = [
    counter(`${p}.tokens.input`, "Input (uncached) tokens consumed", "{token}", inputTokenPoints),
    counter(`${p}.tokens.output`, "Output tokens generated", "{token}", outputTokenPoints),
    counter(`${p}.tokens.cached`, "Cache-read (cached input) tokens", "{token}", cachedTokenPoints),
    counter(`${p}.tokens.total`, "Total tokens consumed", "{token}", totalTokenPoints),
    counter(`${p}.cost.usd`, "Derived USD cost from token usage", "USD", costPoints),
    // ── Activity gauges (point-in-time) ──────────────────────────────────
    gauge(
      `${p}.activity.active_nodes`,
      "Distinct active nodes over the range",
      "{node}",
      [intPoint(activity.activeNodes, [], start, timeUnixNano)],
    ),
    gauge(
      `${p}.activity.active_agents`,
      "Distinct active agents over the range",
      "{agent}",
      [intPoint(activity.activeAgents, [], start, timeUnixNano)],
    ),
    gauge(
      `${p}.activity.sessions`,
      "CLI/chat sessions over the range",
      "{session}",
      [intPoint(activity.sessions, [], start, timeUnixNano)],
    ),
    gauge(
      `${p}.activity.messages`,
      "User messages over the range",
      "{message}",
      [intPoint(activity.messages, [], start, timeUnixNano)],
    ),
    gauge(
      `${p}.activity.stickiness`,
      "Stickiness ratio (DAU/MAU)",
      "1",
      [doublePoint(activity.stickiness, [], start, timeUnixNano)],
    ),
  ];

  return {
    resourceMetrics: [
      {
        resource: { attributes: toAttributes(resourceAttributes) },
        scopeMetrics: [
          {
            scope: { name: p, version: scopeVersion },
            metrics,
          },
        ],
      },
    ],
  };
}
