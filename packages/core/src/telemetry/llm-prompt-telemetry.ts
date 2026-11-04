/**
 * Shared LLM telemetry contract (RUFU-284).
 *
 * FNXC:LaneTelemetry 2026-08-27-00:00:
 * Every LLM lane must leave exactly one `token_usage` record in `usage_events`, and no two seams may
 * credit the same tokens. The contract lives in core because the producers are engine AND dashboard
 * (`packages/dashboard/src/chat.ts`), and a private engine-side union would let the two drift.
 * `AgentTelemetryLane` re-exports this union so self-drift is structurally impossible.
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09:
 * Privacy is a *type-level* contract here, not a runtime scrub: the meta builders accept string-literal
 * unions, hashes, and numbers only, so a caller physically cannot hand a prompt body, soul, memory,
 * answer text, or worktree path to an emit. The sinks only refuse an over-cap `meta` (sync
 * `serializeMeta` throws, the async mirror throws against its own larger cap), so a builder that
 * produced an oversized object would silently drop the row — every builder therefore measures its own
 * output against the SMALLER of the two caps before handing it over.
 */
import { createHash } from "node:crypto";
import { USAGE_EVENT_META_MAX_BYTES } from "../tasks/usage-events.js";

/** Usage-event kind carrying one lane's authoritative token delta. */
export const LLM_TOKEN_USAGE_EVENT_KIND = "token_usage";
/** Usage-event kind carrying one request's system-prompt head evidence (hash only). */
export const LLM_PROMPT_HEAD_EVENT_KIND = "prompt_head";
/** Usage-event kind pairing with a head; deliberately carries NO token numbers. */
export const LLM_PROMPT_END_EVENT_KIND = "prompt_end";

/** The three kinds this contract owns, for a `kinds IN (...)` windowed read. */
export const LLM_TELEMETRY_EVENT_KINDS = [
  LLM_TOKEN_USAGE_EVENT_KIND,
  LLM_PROMPT_HEAD_EVENT_KIND,
  LLM_PROMPT_END_EVENT_KIND,
] as const;

export type LlmTelemetryEventKind = (typeof LLM_TELEMETRY_EVENT_KINDS)[number];

/**
 * Which LLM lane produced an event.
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09 (R4):
 * A lane is ALWAYS an explicit call-site argument, never derived from `options.role`.
 * `accumulateSessionTokenUsage` defaults `role` to `"executor"`, and merger/heartbeat/workflow-step
 * all rely on that default for task attribution; a lane mapped off `role` would label merger spend as
 * executor spend. The union deliberately includes `chat`, which the engine-only
 * `AgentTelemetryLane` never had.
 */
export const LLM_TELEMETRY_LANES = [
  "heartbeat",
  "executor",
  "workflow-step",
  "triage",
  "reviewer",
  "merger",
  "chat",
] as const;

export type LlmTelemetryLane = (typeof LLM_TELEMETRY_LANES)[number];

export function isLlmTelemetryLane(value: unknown): value is LlmTelemetryLane {
  return typeof value === "string" && (LLM_TELEMETRY_LANES as readonly string[]).includes(value);
}

/**
 * What assembled the hashed head bytes.
 *
 * `engine-assembly` is the honest label for the engine-side `systemPromptLayers` / `systemPrompt`
 * value: it does NOT include the pi extension's own prefix, so no consumer may claim full pi
 * fidelity from an `engine-assembly` row.
 */
export const PROMPT_HEAD_SOURCES = [
  "engine-assembly",
  "pi-runtime",
  "pi-assembled",
  "non-pi-runtime",
] as const;

export type PromptHeadSource = (typeof PROMPT_HEAD_SOURCES)[number];

export function isPromptHeadSource(value: unknown): value is PromptHeadSource {
  return typeof value === "string" && (PROMPT_HEAD_SOURCES as readonly string[]).includes(value);
}

/**
 * How this request's head compared to the LAST EMITTED head of the SAME lane.
 * `baseline` = first request since process start (nothing to compare);
 * `identical` = same digest; `diverged` = different digest (see `firstDivergenceOffset`).
 */
export const PROMPT_DIVERGENCE_STATUSES = ["baseline", "identical", "diverged"] as const;

export type PromptDivergenceStatus = (typeof PROMPT_DIVERGENCE_STATUSES)[number];

/** Coarse buckets for the divergence-offset distribution (R1 aggregation). */
export const PROMPT_OFFSET_BUCKETS = ["lt128", "lt1k", "lt8k", "lt64k", "gte64k"] as const;

export type PromptOffsetBucket = (typeof PROMPT_OFFSET_BUCKETS)[number];

/** Byte cap for retained head bytes used by divergence arithmetic (hash-only beyond it). */
export const PROMPT_HEAD_DIVERGENCE_BYTE_CAP = 256 * 1024;

/** Outcome enum for `prompt_end`; deliberately closed so no message text can leak. */
export const PROMPT_END_OUTCOMES = ["completed", "error"] as const;

export type PromptEndOutcome = (typeof PROMPT_END_OUTCOMES)[number];

/** Analytics windows this surface publishes. Anything else is a 400 at the route. */
export const LLM_TELEMETRY_WINDOWS = ["10m", "1h"] as const;

export type LlmTelemetryWindow = (typeof LLM_TELEMETRY_WINDOWS)[number];

export const LLM_TELEMETRY_WINDOW_MS: Record<LlmTelemetryWindow, number> = {
  "10m": 10 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

/**
 * Serialized `meta` must stay under BOTH sink caps: the sync layer refuses at
 * {@link USAGE_EVENT_META_MAX_BYTES} (4 KiB) while the async mirror refuses above 16 KiB. The sync
 * cap is therefore the construction bound — over it, the row is silently dropped rather than shrunk.
 */
export const LLM_TELEMETRY_META_BUDGET_BYTES = USAGE_EVENT_META_MAX_BYTES;

/** Raised by every builder whose output would not survive the sink's meta cap. */
export class LlmTelemetryMetaTooLargeError extends Error {
  constructor(kind: string, bytes: number) {
    super(`LLM telemetry meta for ${kind} exceeds ${LLM_TELEMETRY_META_BUDGET_BYTES} bytes (got ${bytes})`);
    this.name = "LlmTelemetryMetaTooLargeError";
  }
}

function guardMeta(kind: string, meta: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(meta) ?? "", "utf8");
  if (bytes > LLM_TELEMETRY_META_BUDGET_BYTES) {
    throw new LlmTelemetryMetaTooLargeError(kind, bytes);
  }
  return meta;
}

/** Normalizes head text so a CRLF checkout and an LF one hash identically. */
export function normalizePromptHeadBytes(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Lowercase hex sha256 of the normalized head bytes — the only head content ever stored. */
export function hashPromptHead(text: string): string {
  return createHash("sha256").update(normalizePromptHeadBytes(text), "utf8").digest("hex");
}

/** Byte length (not character length) of the normalized head. */
export function promptHeadByteLength(text: string): number {
  return Buffer.byteLength(normalizePromptHeadBytes(text), "utf8");
}

/**
 * 0-based index of the first differing BYTE between two head values.
 *
 * Prefix rule: when one head is a strict prefix of the other the divergence starts at the shorter
 * length. When either head exceeds {@link PROMPT_HEAD_DIVERGENCE_BYTE_CAP} the answer is uncomputable
 * from a hash alone, so the offset is `null` while the status still says `diverged`.
 */
export function firstDivergenceOffset(previous: string, next: string): number | null {
  const prev = normalizePromptHeadBytes(previous);
  const curr = normalizePromptHeadBytes(next);
  if (prev === curr) return null;
  if (
    Buffer.byteLength(prev, "utf8") > PROMPT_HEAD_DIVERGENCE_BYTE_CAP
    || Buffer.byteLength(curr, "utf8") > PROMPT_HEAD_DIVERGENCE_BYTE_CAP
  ) {
    return null;
  }
  const prevBytes = Buffer.from(prev, "utf8");
  const currBytes = Buffer.from(curr, "utf8");
  const shared = Math.min(prevBytes.length, currBytes.length);
  for (let index = 0; index < shared; index += 1) {
    if (prevBytes[index] !== currBytes[index]) return index;
  }
  return shared;
}

/** Buckets a divergence offset for the distribution aggregate; `null` stays `null` (hash-only). */
export function bucketDivergenceOffset(offset: number | null | undefined): PromptOffsetBucket | null {
  if (offset === null || offset === undefined) return null;
  if (offset < 128) return "lt128";
  if (offset < 1_024) return "lt1k";
  if (offset < 8_192) return "lt8k";
  if (offset < 65_536) return "lt64k";
  return "gte64k";
}

/** One lane's authoritative token delta, as written to `usage_events.meta` by its owning seam. */
export interface LlmTokenUsageMeta {
  lane: LlmTelemetryLane;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /**
   * False when the provider never reported a cache-read counter. `cachedTokens: 0` with
   * `cacheReadReported: true` means "the provider said zero"; with the flag false it means
   * "unmeasured" — collapsing the two into a silent 0 is what made hit-rate claims unfalsifiable.
   */
  cacheReadReported: boolean;
  /**
   * Chat-lane provenance only (`chat` | `room-chat` | `cli-chat` | `task-planner-chat`). Omitted for
   * every other lane, so non-chat rows keep the byte-identical closed shape.
   */
  sourceKind?: string;
}

/**
 * Build the `meta` object for one `token_usage` event. Numbers-only by construction: model and
 * provider ride the event's top-level columns, never the meta.
 */
export function buildLlmTokenUsageMeta(input: LlmTokenUsageMeta): Record<string, unknown> {
  if (!isLlmTelemetryLane(input.lane)) {
    throw new TypeError(`token_usage meta requires an explicit LLM telemetry lane, got ${String(input.lane)}`);
  }
  return guardMeta(LLM_TOKEN_USAGE_EVENT_KIND, {
    lane: input.lane,
    inputTokens: Math.max(0, Math.trunc(input.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(input.outputTokens)),
    cachedTokens: Math.max(0, Math.trunc(input.cachedTokens)),
    cacheWriteTokens: Math.max(0, Math.trunc(input.cacheWriteTokens)),
    totalTokens: Math.max(0, Math.trunc(input.totalTokens)),
    cacheReadReported: input.cacheReadReported === true,
    ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
  });
}

/** System-head evidence for ONE request. Hash/length/offsets only — never the head text. */
export interface LlmPromptHeadMeta {
  lane: LlmTelemetryLane;
  /** Correlates this head with its `prompt_end` row. */
  requestId: string;
  headHash: string;
  headBytes: number;
  /** Byte length of the static (cache-stable) half, when the assembly exposed it. */
  staticBytes?: number | null;
  /** Byte length of the runtime-mutable half, when the assembly exposed it. */
  dynamicBytes?: number | null;
  /** Byte index where the dynamic half starts inside the assembled head. */
  dynamicStart?: number | null;
  divergenceStatus: PromptDivergenceStatus;
  firstDivergenceOffset: number | null;
  source: PromptHeadSource;
  runtimeId: string;
  /** Session-creation epoch, so two sessions of one lane are distinguishable in a window. */
  sessionEpoch?: number | null;
}

/**
 * Build the `meta` object for one `prompt_head` event. The builder accepts a digest and sizes —
 * there is no parameter that could receive prompt text, which is the privacy guarantee.
 */
export function buildLlmPromptHeadMeta(input: LlmPromptHeadMeta): Record<string, unknown> {
  if (!isLlmTelemetryLane(input.lane)) {
    throw new TypeError(`prompt_head meta requires an explicit LLM telemetry lane, got ${String(input.lane)}`);
  }
  const meta: Record<string, unknown> = {
    lane: input.lane,
    requestId: input.requestId,
    headHash: input.headHash,
    headBytes: Math.max(0, Math.trunc(input.headBytes)),
    divergenceStatus: input.divergenceStatus,
    firstDivergenceOffset: input.firstDivergenceOffset === null || input.firstDivergenceOffset === undefined
      ? null
      : Math.max(0, Math.trunc(input.firstDivergenceOffset)),
    /*
     * Coarse bucket derived from the offset INSIDE the builder: the panel groups the "where in the head
     * does a lane's prompt start to differ" distribution, and deriving it here makes it impossible for
     * a caller to write an offset and a bucket that disagree.
     */
    offsetBucket: bucketDivergenceOffset(input.firstDivergenceOffset),
    source: input.source,
    runtimeId: input.runtimeId,
  };
  if (input.staticBytes !== undefined && input.staticBytes !== null) meta.staticBytes = Math.max(0, Math.trunc(input.staticBytes));
  if (input.dynamicBytes !== undefined && input.dynamicBytes !== null) meta.dynamicBytes = Math.max(0, Math.trunc(input.dynamicBytes));
  if (input.dynamicStart !== undefined && input.dynamicStart !== null) meta.dynamicStart = Math.max(0, Math.trunc(input.dynamicStart));
  if (input.sessionEpoch !== undefined && input.sessionEpoch !== null) meta.sessionEpoch = Math.trunc(input.sessionEpoch);
  return guardMeta(LLM_PROMPT_HEAD_EVENT_KIND, meta);
}

/** Tail evidence for one request. Carries NO token numbers — `token_usage` owns those. */
export interface LlmPromptEndMeta {
  lane: LlmTelemetryLane;
  requestId: string;
  outcome: PromptEndOutcome;
  durationMs: number;
}

/** Build the `meta` object for one `prompt_end` event. */
export function buildLlmPromptEndMeta(input: LlmPromptEndMeta): Record<string, unknown> {
  if (!isLlmTelemetryLane(input.lane)) {
    throw new TypeError(`prompt_end meta requires an explicit LLM telemetry lane, got ${String(input.lane)}`);
  }
  return guardMeta(LLM_PROMPT_END_EVENT_KIND, {
    lane: input.lane,
    requestId: input.requestId,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
  });
}

// ── Windowed aggregate contract (R1) ─────────────────────────────────

/**
 * Prompt tokens for this surface: `inputTokens + cachedTokens`, deliberately WITHOUT output.
 * Cache-read share is a prompt-side efficiency ratio; folding output into its denominator would make
 * a verbose answer look like a cache miss.
 */
export function promptTokensOf(usage: { inputTokens: number; cachedTokens: number }): number {
  return usage.inputTokens + usage.cachedTokens;
}

/** `sum(cached) / sum(promptTokens)`; `null` when the window has no prompt-token denominator. */
export function cacheReadShareOf(sum: { cachedTokens: number; promptTokens: number }): number | null {
  if (sum.promptTokens <= 0) return null;
  return sum.cachedTokens / sum.promptTokens;
}

/** Heartbeat prompt tokens / all-lane prompt tokens; `null` when no lane reported prompt tokens. */
export function heartbeatPromptTokenShareOf(
  heartbeatPromptTokens: number,
  totalPromptTokens: number,
): number | null {
  if (totalPromptTokens <= 0) return null;
  return heartbeatPromptTokens / totalPromptTokens;
}

/** Lower median (n/2-th of a sorted list); `null` for an empty window, never 0. */
export function lowerMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** Per-lane token sums from `token_usage` rows. */
export interface LlmLaneTokenSums {
  lane: LlmTelemetryLane;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  promptTokens: number;
  /** True when at least one row in the window came from a provider that reports cache reads. */
  cacheReadReported: boolean;
}

/** Per-lane prompt-head stability from `prompt_head` rows. */
export interface LlmLaneHeadStability {
  lane: LlmTelemetryLane;
  headEventCount: number;
  distinctHeadHashCount: number;
  /** Lower median of head byte lengths; `null` for an empty window. */
  medianHeadBytes: number | null;
  divergenceCounts: Record<PromptDivergenceStatus, number>;
  offsetBucketCounts: Record<PromptOffsetBucket, number>;
  /** Divergences whose offset was uncomputable (head beyond the byte cap, hash-only memory). */
  offsetUnknownCount: number;
}

/** One lane's complete windowed row: token sums, cache share, and head stability. */
export interface LlmLaneAggregate {
  lane: LlmTelemetryLane;
  tokens: LlmLaneTokenSums;
  cacheReadShare: number | null;
  head: LlmLaneHeadStability;
}

/** One `lane × model` cell of the panel's honeycomb. */
export interface LlmTelemetryGridCell {
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
 * One `prompt_head` row as the panel receives it. Declared as a name (not inline) because the surface
 * renders it as its own row and must be able to say what a row IS; the field set is the closed privacy
 * vocabulary — hash, sizes, offsets, ids — with no member that could hold prompt text.
 */
export interface LlmTelemetryHeadEvent {
  id: number;
  ts: string;
  lane: LlmTelemetryLane;
  requestId: string | null;
  headHash: string | null;
  headBytes: number | null;
  staticBytes: number | null;
  dynamicBytes: number | null;
  dynamicStart: number | null;
  divergenceStatus: PromptDivergenceStatus | null;
  firstDivergenceOffset: number | null;
  source: PromptHeadSource | null;
  runtimeId: string | null;
}

/** The `GET /api/command-center/llm-telemetry` response contract. */
export interface LlmTelemetryReport {
  window: LlmTelemetryWindow;
  from: string;
  to: string;
  /** lane × model grid cell. */
  grid: LlmTelemetryGridCell[];
  aggregates: LlmLaneAggregate[];
  totalPromptTokens: number;
  heartbeatPromptTokenShare: number | null;
  headEvents: LlmTelemetryHeadEvent[];
  gridTruncated: boolean;
  headTruncated: boolean;
}
