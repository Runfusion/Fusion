/**
 * LLM lane telemetry emitters (RUFU-284).
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09:
 * One file owns every LLM-usage and prompt-evidence emit so the single-emit-per-lane invariant has one
 * place to be read. The invariant: exactly ONE seam per lane computes the authoritative token delta and
 * emits `token_usage`, and that lane's `lane` value is an explicit call-site argument. `lane` is never
 * derived from `options.role` — `accumulateSessionTokenUsage` defaults `role` to `"executor"` and
 * merger/heartbeat/workflow-step rely on that default for task attribution, so a role-derived lane
 * would book merger spend as executor spend (R4).
 *
 * Every emitter here is fire-and-forget: a store without `emitUsageEvent`, a throwing one, or a
 * rejected one must not change, delay, abort, or reverse the lane it observes. That is why no public
 * function in this file is `async` (the one exception, {@link withPromptRequestTelemetry}, only awaits
 * the work it wraps) and why each emit wraps both the synchronous throw and the rejection.
 *
 * Privacy is structural, not a scrub pass: the builders in `@fusion/core` accept numbers and closed
 * string unions, and the head text never leaves this module — it is hashed, measured, compared to the
 * lane's previous head for a byte offset, and dropped.
 */
import { randomUUID } from "node:crypto";
import type { TaskStore } from "@fusion/core";
import {
  buildLlmPromptEndMeta,
  buildLlmPromptHeadMeta,
  buildLlmTokenUsageMeta,
  firstDivergenceOffset,
  hashPromptHead,
  LLM_PROMPT_END_EVENT_KIND,
  LLM_PROMPT_HEAD_EVENT_KIND,
  LLM_TOKEN_USAGE_EVENT_KIND,
  promptHeadByteLength,
  type LlmTelemetryLane,
  type PromptDivergenceStatus,
  type PromptEndOutcome,
  type PromptHeadSource,
} from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentTelemetryLane } from "./agent-usage-telemetry.js";
import { createLogger } from "../logger.js";

/*
FNXC:LaneTelemetry 2026-11-04-05:45:
The pre-existing `session_start` / `session_end` rows already carry a `lane`, written by
`agent-usage-telemetry.ts` from its own union. Both vocabularies must describe the same lanes with the
same words, or a panel joining a session boundary to its spend by lane silently matches nothing. This
type-level assertion is the cheapest way to keep them from drifting: widening `AgentTelemetryLane` past
`LlmTelemetryLane` stops compiling. `LlmTelemetryLane` is the wider set on purpose — `chat` has no agent
session to attach a boundary row to.
*/
type AgentLaneIsSubsetOfLlmLane = AgentTelemetryLane extends LlmTelemetryLane ? true : never;
const _agentLaneVocabularyIsSubset: AgentLaneIsSubsetOfLlmLane = true;

const log = createLogger("prompt-telemetry");

/** Retained per lane for offset computation only; past this the engine keeps the hash and says `diverged`. */
const MAX_RETAINED_HEAD_BYTES = 256 * 1024;

/** Token deltas in the same units `task.tokenUsage` uses. */
export interface LaneTokenDelta {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface LaneTokenUsageEmit {
  store: TaskStore;
  /** Explicit lane; never inferred. */
  lane: LlmTelemetryLane;
  delta: LaneTokenDelta;
  /** False when the provider never reported a cache-read counter (vs. a reported zero). */
  cacheReadReported: boolean;
  taskId?: string | null;
  agentId?: string | null;
  nodeId?: string | null;
  model?: string | null;
  provider?: string | null;
  sourceKind?: string;
}

/** Non-sensitive model identity for a session, tolerating pi's object and ACP's string shapes. */
export function readSessionModelIdentity(session: unknown): { model: string | null; provider: string | null } {
  const model = (session as { model?: unknown } | undefined)?.model;
  if (model && typeof model === "object") {
    const { provider, id } = model as { provider?: unknown; id?: unknown };
    return {
      model: typeof id === "string" && id.trim() ? id.trim() : null,
      provider: typeof provider === "string" && provider.trim() ? provider.trim() : null,
    };
  }
  if (typeof model === "string" && model.trim()) return { model: model.trim(), provider: null };
  return { model: null, provider: null };
}

/**
 * Emit one `token_usage` row. A zero delta is skipped — a row with no numbers would inflate
 * `requestCount` without describing any spend, the exact distortion this surface exists to remove.
 */
export function emitLaneTokenUsageEvent(emit: LaneTokenUsageEmit): void {
  const { delta } = emit;
  if (
    delta.inputTokens === 0
    && delta.outputTokens === 0
    && delta.cachedTokens === 0
    && delta.cacheWriteTokens === 0
    && delta.totalTokens === 0
  ) {
    return;
  }
  try {
    settle(emit.store.emitUsageEvent({
      kind: LLM_TOKEN_USAGE_EVENT_KIND,
      taskId: emit.taskId ?? null,
      agentId: emit.agentId ?? null,
      nodeId: emit.nodeId ?? null,
      model: emit.model ?? null,
      provider: emit.provider ?? null,
      category: "llm-usage",
      meta: buildLlmTokenUsageMeta({
        lane: emit.lane,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cachedTokens: delta.cachedTokens,
        cacheWriteTokens: delta.cacheWriteTokens,
        totalTokens: delta.totalTokens,
        cacheReadReported: emit.cacheReadReported,
        sourceKind: emit.sourceKind,
      }),
    }));
  } catch (error) {
    log.warn(`token_usage emit refused (${emit.lane}): ${describeError(error)}`);
  }
}

// ── Event-only accounting for lanes with no task writer ──────────────

interface SessionTokenSnapshot {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  cacheReadReported: boolean;
}

const laneBaselines = new WeakMap<AgentSession, SessionTokenSnapshot>();

function readSessionTokens(session: AgentSession): SessionTokenSnapshot | undefined {
  const accessor = (session as unknown as { getSessionStats?: () => unknown }).getSessionStats;
  if (typeof accessor !== "function") return undefined;
  let stats: unknown;
  try {
    stats = accessor.call(session);
  } catch {
    return undefined;
  }
  if (stats && typeof (stats as { then?: unknown }).then === "function") {
    // A promise-shaped stat reader cannot be read synchronously; that lane's own delta seam owns it.
    return undefined;
  }
  const tokens = (stats as { tokens?: Record<string, unknown> } | undefined)?.tokens;
  if (!tokens) return undefined;
  return {
    input: typeof tokens.input === "number" ? tokens.input : 0,
    output: typeof tokens.output === "number" ? tokens.output : 0,
    cached: typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0,
    cacheWrite: typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0,
    // `cacheRead` absent is NOT zero: the provider never answered the question.
    cacheReadReported: typeof tokens.cacheRead === "number",
  };
}

/**
 * Emit the cumulative session usage NOT yet credited for this session, for lanes that never write
 * `task.tokenUsage` (reviewer, idle heartbeat).
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09 (R3):
 * This is the ONLY emitter allowed for a lane with no accounting seam, and it is event-only BY
 * CONSTRUCTION — it never calls `updateTask`. A lane that already credits `task.tokenUsage` (executor,
 * workflow-step, merger, heartbeat-with-task, triage) must emit inside that credit instead, or the same
 * tokens are counted twice in the numbers RUFU-267/268 are verified against.
 */
export function emitLaneTokenUsage(
  store: TaskStore,
  lane: LlmTelemetryLane,
  session: AgentSession | undefined,
  identity: { taskId?: string | null; agentId?: string | null; nodeId?: string | null } = {},
): void {
  if (!session) return;
  const current = readSessionTokens(session);
  if (!current) return;
  const baseline = laneBaselines.get(session) ?? { input: 0, output: 0, cached: 0, cacheWrite: 0, cacheReadReported: false };
  laneBaselines.set(session, current);
  const model = readSessionModelIdentity(session);
  emitLaneTokenUsageEvent({
    store,
    lane,
    taskId: identity.taskId ?? null,
    agentId: identity.agentId ?? null,
    nodeId: identity.nodeId ?? null,
    model: model.model,
    provider: model.provider,
    cacheReadReported: current.cacheReadReported,
    delta: {
      inputTokens: Math.max(0, current.input - baseline.input),
      outputTokens: Math.max(0, current.output - baseline.output),
      cachedTokens: Math.max(0, current.cached - baseline.cached),
      cacheWriteTokens: Math.max(0, current.cacheWrite - baseline.cacheWrite),
      totalTokens: 0,
    },
  });
}

/** Drop a disposed session's baseline so a reused object cannot under-credit the next run. */
export function resetLaneTokenBaseline(session: AgentSession): void {
  laneBaselines.delete(session);
}

// ── Prompt head / tail evidence ──────────────────────────────────────

/** The two halves of an assembled system prompt, in the order they are actually sent. */
export interface AssembledPromptHead {
  /** The cacheable stable prefix — the half whose byte-stability RUFU-267 claims. */
  stable: string;
  /** The volatile request-tail block RUFU-267 moved out of the serialized prompt, if any. */
  dynamic?: string;
}

/** What the engine knows about one session's system head: identity plus a reader, never a stored body. */
export interface PromptHeadRecord {
  lane: LlmTelemetryLane;
  store: TaskStore;
  source: PromptHeadSource;
  runtimeId: string;
  /*
   * A READER, not a snapshot: pi builds the system prompt through a `systemPromptOverride` callback
   * evaluated per request, so capturing the head at session-creation time would report the FIRST
   * request's head forever. The text is hashed, measured, diffed, and dropped per request.
   */
  readHead: () => AssembledPromptHead | undefined;
  agentId: string | null;
  taskId: string | null;
  nodeId: string | null;
  sessionEpoch: number;
}

const headRecords = new WeakMap<AgentSession, PromptHeadRecord>();

/**
 * Remember how to read a session's head so each request can emit its own evidence row.
 *
 * Recording is not emitting: the row is written per REQUEST (see {@link withPromptRequestTelemetry}),
 * because per-request divergence against the lane's previous request is the measurement RUFU-267 needs.
 * A session created without a lane records nothing and therefore emits no head or tail row.
 */
export function attachPromptHeadRecord(session: AgentSession, record: PromptHeadRecord): void {
  try {
    headRecords.set(session, record);
  } catch (error) {
    log.warn(`prompt head attach refused: ${describeError(error)}`);
  }
}

export function getPromptHeadRecord(session: AgentSession): PromptHeadRecord | undefined {
  return headRecords.get(session);
}

/**
 * Lane → last emitted head. Process-scoped and byte-capped.
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09 (R2):
 * Keyed by LANE, not by session, because the claim under test is that one lane's serialized prefix is
 * identical between two consecutive requests — a second executor session that rebuilds the same prompt
 * must read `identical`, and one that rebuilds it differently must read `diverged` even though both are
 * the same process. Only the digest plus up to {@link MAX_RETAINED_HEAD_BYTES} are retained, and the
 * bytes exist solely to compute `firstDivergenceOffset`; past the cap the engine keeps the hash and
 * reports `diverged` with a null offset rather than hold an unbounded prompt body in the daemon.
 */
interface LastLaneHead {
  hash: string;
  text: string | null;
}

const lastLaneHead = new Map<LlmTelemetryLane, LastLaneHead>();

/** Test/operator seam: the ledger is process state, so a new process must report `baseline`. */
export function resetPromptHeadDivergenceLedger(lane?: LlmTelemetryLane): void {
  if (lane) lastLaneHead.delete(lane);
  else lastLaneHead.clear();
}

function resolveDivergence(lane: LlmTelemetryLane, headHash: string, headText: string): {
  status: PromptDivergenceStatus;
  offset: number | null;
} {
  const previous = lastLaneHead.get(lane);
  const retained = Buffer.byteLength(headText, "utf8") <= MAX_RETAINED_HEAD_BYTES ? headText : null;
  lastLaneHead.set(lane, { hash: headHash, text: retained });
  if (!previous) return { status: "baseline", offset: null };
  if (previous.hash === headHash) return { status: "identical", offset: null };
  if (previous.text === null) return { status: "diverged", offset: null };
  return { status: "diverged", offset: firstDivergenceOffset(previous.text, headText) };
}

/** Emits this request's head row and returns the record so the tail can pair with the same identity. */
function emitPromptHeadForRequest(session: AgentSession, requestId: string): PromptHeadRecord | undefined {
  const record = headRecords.get(session);
  if (!record) return undefined;
  try {
    const head = record.readHead();
    if (!head) return undefined;
    const headHash = hashPromptHead(head.stable);
    const headBytes = promptHeadByteLength(head.stable);
    const dynamicBytes = head.dynamic === undefined ? null : promptHeadByteLength(head.dynamic);
    const divergence = resolveDivergence(record.lane, headHash, head.stable);
    settle(record.store.emitUsageEvent({
      kind: LLM_PROMPT_HEAD_EVENT_KIND,
      taskId: record.taskId,
      agentId: record.agentId,
      nodeId: record.nodeId,
      category: "llm-prompt",
      meta: buildLlmPromptHeadMeta({
        lane: record.lane,
        requestId,
        headHash,
        headBytes,
        // The stable half is the whole serialized prompt, so the volatile tail begins at its end.
        staticBytes: headBytes,
        dynamicBytes,
        dynamicStart: head.dynamic === undefined ? null : headBytes,
        divergenceStatus: divergence.status,
        firstDivergenceOffset: divergence.offset,
        source: record.source,
        runtimeId: record.runtimeId,
        sessionEpoch: record.sessionEpoch,
      }),
    }));
  } catch (error) {
    log.warn(`prompt_head emit refused (${record.lane}): ${describeError(error)}`);
    return undefined;
  }
  return record;
}

function emitPromptEndForRequest(record: PromptHeadRecord, requestId: string, outcome: PromptEndOutcome, startedAt: number): void {
  try {
    settle(record.store.emitUsageEvent({
      kind: LLM_PROMPT_END_EVENT_KIND,
      taskId: record.taskId,
      agentId: record.agentId,
      nodeId: record.nodeId,
      category: "llm-prompt",
      meta: buildLlmPromptEndMeta({
        lane: record.lane,
        requestId,
        outcome,
        durationMs: Date.now() - startedAt,
      }),
    }));
  } catch (error) {
    log.warn(`prompt_end emit refused (${record.lane}): ${describeError(error)}`);
  }
}

/**
 * Requests already being measured in this process, so a nested `promptWithFallback` for the same
 * session (pi's attached-dispatch closure re-enters the exported function) is ONE logical request and
 * leaves ONE head/tail pair, not two.
 */
const measuredRequests = new WeakSet<AgentSession>();

/**
 * Wraps ONE prompt request with head + tail evidence.
 *
 * FNXC:LaneTelemetry 2026-11-04-05:09 (R2):
 * The wrapper sits at the request boundary, not at session creation: the executor's dominant path is
 * the session-attached `promptWithFallback` closure, so a creation-time emit would fire once per session
 * and could never answer "did this request's head differ from the last one?". The tail lives in a
 * `finally` around the whole body so the attached-dispatch branch, the direct prompt, and the
 * context-limit compact retries all pair their head. A session with no head record runs untouched.
 *
 * The tail row carries NO token numbers — `token_usage` owns them, and a second row with the same
 * counters would double-count every lane.
 */
export async function withPromptRequestTelemetry<T>(
  session: AgentSession,
  run: () => Promise<T>,
): Promise<T> {
  if (!headRecords.has(session) || measuredRequests.has(session)) return run();
  const requestId = randomUUID();
  const startedAt = Date.now();
  let outcome: PromptEndOutcome = "completed";
  measuredRequests.add(session);
  // The head is emitted BEFORE the request runs: a request that dies mid-flight still shows what it
  // was sent with, which is the incident question this row exists to answer.
  const record = emitPromptHeadForRequest(session, requestId);
  try {
    return await run();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    measuredRequests.delete(session);
    if (record) emitPromptEndForRequest(record, requestId, outcome, startedAt);
  }
}

/** True when this session has head telemetry attached; lets callers skip the wrapper cheaply. */
export function hasPromptRequestTelemetry(session: AgentSession): boolean {
  return headRecords.has(session);
}

function settle(result: unknown): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result as Promise<unknown>).catch((error: unknown) => {
      log.warn(`LLM telemetry sink rejected: ${describeError(error)}`);
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
