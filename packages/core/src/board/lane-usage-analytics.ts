/**
 * Windowed LLM lane telemetry over `usage_events` (RUFU-284).
 *
 * FNXC:TokenAnalytics 2026-11-04-05:09:
 * This module reads ONE source: `usage_events`. It must never call `aggregateTokenAnalytics` and never
 * touch `tasks.token_usage` or `chat_token_usage` — those are two other accounting systems with other
 * owners (the first credits a task through delta seams, the second owns chat turns). Summing any two of
 * them double-counts the same spend, so the panel shows the sources side by side and never adds them.
 * The boundary is enforced here by construction: this file imports only the usage-event reader, and the
 * RUFU-284 test scans its imports to keep it that way.
 *
 * Rows are aggregated in JS rather than SQL because the honest-absence rules have to survive: a provider
 * that never reported a cache-read counter must be EXCLUDED from a median and a share, which a SQL
 * `SUM` over a coalesced zero would silently get wrong.
 */
import type { Database } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import { queryUsageEvents, type UsageEvent } from "../tasks/usage-events.js";
import { queryUsageEvents as queryUsageEventsAsync } from "../task-store/async/async-events.js";
import {
  isLlmTelemetryLane,
  LLM_TELEMETRY_EVENT_KINDS,
  LLM_TELEMETRY_WINDOW_MS,
  LLM_TOKEN_USAGE_EVENT_KIND,
  LLM_PROMPT_HEAD_EVENT_KIND,
  promptTokensOf,
  cacheReadShareOf,
  heartbeatPromptTokenShareOf,
  lowerMedian,
  type LlmTelemetryLane,
  type LlmTelemetryReport,
  type LlmTelemetryWindow,
  type LlmLaneAggregate,
  type LlmLaneHeadStability,
  type LlmLaneTokenSums,
  type PromptDivergenceStatus,
  type PromptHeadSource,
  type PromptOffsetBucket,
} from "../telemetry/llm-prompt-telemetry.js";

/** Cells the panel can render before the response says it stopped counting. */
const GRID_MAX_CELLS = 240;
/** Head rows returned newest-first for the recent-events list. */
const HEAD_EVENTS_MAX = 120;
/**
 * Row ceiling for the async scan only. The async reader orders `ts DESC`, so a limit keeps the RECENT
 * end of the window; the sync reader orders `ts ASC` and would keep the oldest rows, so the sync branch
 * is bounded by the window itself and passes no limit.
 */
const SCAN_ROW_LIMIT = 5_000;

export interface LlmLaneTelemetryQuery {
  /** Window length; defaults to `1h`. An unknown value is the caller's error, not a silent default. */
  window?: LlmTelemetryWindow;
  /** Window end; defaults to now. Injectable so tests and replays are deterministic. */
  to?: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function emptyDivergenceCounts(): Record<PromptDivergenceStatus, number> {
  return { baseline: 0, identical: 0, diverged: 0 };
}

function emptyOffsetBuckets(): Record<PromptOffsetBucket, number> {
  return { lt128: 0, lt1k: 0, lt8k: 0, lt64k: 0, gte64k: 0 };
}

interface Cell {
  lane: LlmTelemetryLane;
  model: string | null;
  provider: string | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheReadReported: boolean;
}

/**
 * Aggregate one window of LLM lane telemetry.
 *
 * Accepts either storage backend like the other board analytics: the sync `Database` handle or the
 * PostgreSQL `AsyncDataLayer`. An empty window returns zeroed aggregates and empty arrays — never nulls
 * — so the panel can distinguish "no traffic" from "no data".
 */
export async function aggregateLlmLaneTelemetry(
  dbOrLayer: Database | AsyncDataLayer,
  query: LlmLaneTelemetryQuery = {},
): Promise<LlmTelemetryReport> {
  const { from, to } = resolveWindow(query);
  const range = { from, to, kinds: LLM_TELEMETRY_EVENT_KINDS };

  let events: UsageEvent[];
  if ("ping" in dbOrLayer) {
    const layer = dbOrLayer as AsyncDataLayer;
    const rows = await queryUsageEventsAsync(layer.db, layer.projectId ?? "", { ...range, limit: SCAN_ROW_LIMIT });
    // The async reader returns newest-first; the aggregation is order-insensitive except for the
    // divergence sequence, so normalise to ascending here.
    events = [...rows].reverse();
  } else {
    events = queryUsageEvents(dbOrLayer as Database, range);
  }

  return computeLlmLaneTelemetry(events, { window: query.window ?? "1h", from, to });
}

function resolveWindow(query: LlmLaneTelemetryQuery): { from: string; to: string; window: LlmTelemetryWindow } {
  const window: LlmTelemetryWindow = query.window ?? "1h";
  const toMs = query.to ? Date.parse(query.to) : Date.now();
  const to = new Date(toMs).toISOString();
  const from = new Date(toMs - LLM_TELEMETRY_WINDOW_MS[window]).toISOString();
  return { from, to, window };
}

/**
 * The pure half of the aggregation: rows in, report out, no storage handle.
 *
 * It is exported because the honest-absence rules ARE the product logic, and a test that reaches them
 * through a database would need one to prove a division.
 */
export function computeLlmLaneTelemetry(
  events: readonly UsageEvent[],
  bounds: { window: LlmTelemetryWindow; from: string; to: string },
): LlmTelemetryReport {
  const { window, from, to } = bounds;

  const cells = new Map<string, Cell>();
  const laneSums = new Map<LlmTelemetryLane, LlmLaneTokenSums>();
  const laneHeads = new Map<LlmTelemetryLane, {
    hashes: Set<string>;
    headBytes: number[];
    divergence: Record<PromptDivergenceStatus, number>;
    offsetBuckets: Record<PromptOffsetBucket, number>;
    offsetUnknown: number;
  }>();
  const headEvents: LlmTelemetryReport["headEvents"] = [];
  let totalPromptTokens = 0;
  let heartbeatPromptTokens = 0;

  for (const event of events) {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    const lane = meta.lane;
    if (!isLlmTelemetryLane(lane)) continue;

    if (event.kind === LLM_TOKEN_USAGE_EVENT_KIND) {
      const sums = laneSums.get(lane) ?? {
        lane,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        promptTokens: 0,
        cacheReadReported: false,
      };
      const promptTokens = promptTokensOf({ inputTokens: num(meta.inputTokens), cachedTokens: num(meta.cachedTokens) });
      sums.requestCount += 1;
      sums.inputTokens += num(meta.inputTokens);
      sums.outputTokens += num(meta.outputTokens);
      sums.cachedTokens += num(meta.cachedTokens);
      sums.cacheWriteTokens += num(meta.cacheWriteTokens);
      sums.totalTokens += num(meta.totalTokens);
      sums.promptTokens += promptTokens;
      // Only a row that says the provider ANSWERS the cache question makes the lane's share meaningful.
      sums.cacheReadReported ||= bool(meta.cacheReadReported);
      laneSums.set(lane, sums);
      totalPromptTokens += promptTokens;
      if (lane === "heartbeat") heartbeatPromptTokens += promptTokens;

      const key = `${lane}\u0000${event.model ?? ""}\u0000${event.provider ?? ""}`;
      const cell = cells.get(key) ?? {
        lane,
        model: event.model ?? null,
        provider: event.provider ?? null,
        eventCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cacheReadReported: false,
      };
      cell.eventCount += 1;
      cell.inputTokens += num(meta.inputTokens);
      cell.outputTokens += num(meta.outputTokens);
      cell.cachedTokens += num(meta.cachedTokens);
      cell.cacheWriteTokens += num(meta.cacheWriteTokens);
      cell.totalTokens += num(meta.totalTokens);
      cell.cacheReadReported ||= bool(meta.cacheReadReported);
      cells.set(key, cell);
      continue;
    }

    if (event.kind === LLM_PROMPT_HEAD_EVENT_KIND) {
      const heads = laneHeads.get(lane) ?? {
        hashes: new Set<string>(),
        headBytes: [],
        divergence: emptyDivergenceCounts(),
        offsetBuckets: emptyOffsetBuckets(),
        offsetUnknown: 0,
      };
      const hash = str(meta.headHash);
      if (hash) heads.hashes.add(hash);
      const headBytes = numOrNull(meta.headBytes);
      if (headBytes !== null) heads.headBytes.push(headBytes);
      const status = meta.divergenceStatus;
      if (status === "baseline" || status === "identical" || status === "diverged") {
        heads.divergence[status] += 1;
        if (status === "diverged") {
          const bucket = meta.offsetBucket;
          if (bucket === "lt128" || bucket === "lt1k" || bucket === "lt8k" || bucket === "lt64k" || bucket === "gte64k") {
            heads.offsetBuckets[bucket] += 1;
          } else {
            // A divergence the engine could not localise (head past the retained-byte cap). Counting it
            // separately keeps the distribution honest instead of quietly dropping it.
            heads.offsetUnknown += 1;
          }
        }
      }
      laneHeads.set(lane, heads);

      headEvents.unshift({
        id: event.id,
        ts: event.ts,
        lane,
        requestId: str(meta.requestId),
        headHash: hash,
        headBytes,
        staticBytes: numOrNull(meta.staticBytes),
        dynamicBytes: numOrNull(meta.dynamicBytes),
        dynamicStart: numOrNull(meta.dynamicStart),
        divergenceStatus: status === "baseline" || status === "identical" || status === "diverged" ? status : null,
        firstDivergenceOffset: numOrNull(meta.firstDivergenceOffset),
        source: str(meta.source) as PromptHeadSource | null,
        runtimeId: str(meta.runtimeId),
      });
    }
  }

  const aggregates: LlmLaneAggregate[] = [...new Set<LlmTelemetryLane>([
    ...laneSums.keys(),
    ...laneHeads.keys(),
  ])].map((lane) => {
    const tokens: LlmLaneTokenSums = laneSums.get(lane) ?? {
      lane,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      promptTokens: 0,
      cacheReadReported: false,
    };
    const heads = laneHeads.get(lane);
    const head: LlmLaneHeadStability = {
      lane,
      headEventCount: headEvents.filter((row) => row.lane === lane).length,
      distinctHeadHashCount: heads?.hashes.size ?? 0,
      medianHeadBytes: lowerMedian(heads?.headBytes ?? []),
      divergenceCounts: heads?.divergence ?? emptyDivergenceCounts(),
      offsetBucketCounts: heads?.offsetBuckets ?? emptyOffsetBuckets(),
      offsetUnknownCount: heads?.offsetUnknown ?? 0,
    };
    return {
      lane,
      tokens,
      // A lane whose providers never report cache reads shows "unmeasured", never a computed 0%.
      cacheReadShare: tokens.cacheReadReported ? cacheReadShareOf(tokens) : null,
      head,
    };
  }).sort((a, b) => b.tokens.promptTokens - a.tokens.promptTokens || a.lane.localeCompare(b.lane));

  const allCells = [...cells.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.lane.localeCompare(b.lane));
  const grid = allCells.slice(0, GRID_MAX_CELLS);
  const recentHeadEvents = headEvents.slice(0, HEAD_EVENTS_MAX);

  return {
    window,
    from,
    to,
    grid,
    aggregates,
    totalPromptTokens,
    heartbeatPromptTokenShare: heartbeatPromptTokenShareOf(heartbeatPromptTokens, totalPromptTokens),
    headEvents: recentHeadEvents,
    // Truncation is reported rather than silently applied: a panel that shows 240 of 400 cells has to
    // say so, or an operator reads a partial grid as the whole lane population.
    gridTruncated: allCells.length > grid.length || events.length >= SCAN_ROW_LIMIT,
    headTruncated: headEvents.length > recentHeadEvents.length,
  };
}
