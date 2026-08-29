import { recordRunAuditEvent, type AsyncDataLayer } from "../postgres/data-layer.js";
import type { Logger } from "../process/logger.js";
import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types.js";
import { appendRecall } from "./recall/recall-store.js";
import type { RecallAppendInput, RecallAppendResult, RecallKind, RecallOrigin } from "./recall/recall-types.js";

/** The largest durable summary a capture origin may add to recall. */
export const RECALL_CAPTURE_CONTENT_MAX_BYTES = 4_096;

/** Origins that have an automatic-capture contract, rather than arbitrary recall origins. */
export type RecallCaptureOrigin = "task-completion" | "research-finding" | "insight";

/**
 * The durable, bounded material supplied by an automatic capture seam.
 *
 * Callers provide a summary rather than a raw prompt or model output: recall is a compact memory
 * of an outcome, not a second transcript store.
 */
export interface RecallCaptureInput {
  origin: RecallCaptureOrigin;
  summary: string;
  title?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  /** Origin IDs are retained as compact tags because FN-8922 has one generic source shape. */
  researchRunId?: string;
  findingId?: string;
  insightId?: string;
  tags?: readonly string[];
  /** A real graph node id already known by the caller; capture never invents one. */
  graphNodeId?: string;
}

/** The capture surface is deliberately one-way: callers cannot await durable memory. */
export interface RecallCaptureWriter {
  capture(input: RecallCaptureInput): void;
}

/** Test-only observability for work intentionally detached from its production seam. */
export interface RecallCaptureWriterTestDrain {
  flushPendingCaptures(): Promise<void>;
}

export type RecallCaptureWriterWithTestDrain = RecallCaptureWriter & RecallCaptureWriterTestDrain;

/** The recall kind is part of each origin's durable contract. */
export const RECALL_CAPTURE_KIND_BY_ORIGIN: Readonly<Record<RecallCaptureOrigin, RecallKind>> = {
  "task-completion": "solution",
  "research-finding": "solution",
  insight: "decision",
};

/** Maps capture seams onto the real FN-8922 source-origin literals. */
export const RECALL_CAPTURE_SOURCE_ORIGIN_BY_ORIGIN: Readonly<Record<RecallCaptureOrigin, RecallOrigin>> = {
  "task-completion": "task-completion",
  "research-finding": "deep-research",
  insight: "other",
};

export interface RecallCaptureWriterDependencies {
  /** The FN-8922 persistence layer used by the production appendRecall API. */
  layer: AsyncDataLayer;
  logger: Pick<Logger, "warn">;
  /** Test seam only; production omits this and calls FN-8922 appendRecall directly. */
  append?: (input: RecallAppendInput) => Promise<RecallAppendResult>;
  /** Optional audit adapter; production defaults to the core run-audit persistence seam. */
  audit?: (input: { type: "memory:capture-recorded" | "memory:capture-failed"; metadata: Record<string, string> }) => Promise<void>;
}

/*
FNXC:MemoryRecallCapture 2026-08-11-10:57:
Automatic recall capture returns void so a completion, research, or insight call site cannot await
memory persistence and make optional memory load-bearing. The shared no-op is only the absent or
disabled-memory default; named composition roots must replace it with this factory's live writer.

FNXC:MemoryRecallCapture 2026-08-11-10:57:
FN-8922 has no insight-specific RecallOrigin literal, so insight outcomes use its real "other"
origin while completed tasks and research use "task-completion" and "deep-research" respectively.
The test drain exists solely for deterministic detached-work tests and production must never call it.

FNXC:RunAudit 2026-08-20-07:03:
FN-9181 implements FN-9178's class-A decision: bounded audit emission prevents a stalled sink from
retaining a detached capture promise. Preserve the injectable adapter's bare-metadata contract, and
suppress the layer path whenever append is injected so the deterministic test seam remains isolated.
*/
export const NOOP_RECALL_CAPTURE_WRITER: RecallCaptureWriter = Object.freeze({
  capture: () => {},
});

function clampUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

/** Build a compact, origin-labelled recall summary without retaining raw model material. */
export function buildRecallCaptureContent(input: RecallCaptureInput): string {
  const lines = [`[${input.origin}]`];
  if (input.title?.trim()) lines.push(`Title: ${input.title.trim()}`);
  lines.push(`Summary: ${input.summary.trim()}`);
  return clampUtf8(lines.join("\n"), RECALL_CAPTURE_CONTENT_MAX_BYTES);
}

function sourceIdentifierTags(input: RecallCaptureInput): string[] {
  return [
    input.researchRunId?.trim() ? `research-run:${input.researchRunId.trim()}` : undefined,
    input.findingId?.trim() ? `research-finding:${input.findingId.trim()}` : undefined,
    input.insightId?.trim() ? `insight:${input.insightId.trim()}` : undefined,
  ].filter((tag): tag is string => Boolean(tag));
}

function toAppendInput(input: RecallCaptureInput): RecallAppendInput {
  const graphNodeIds = input.graphNodeId?.trim() ? [input.graphNodeId.trim()] : undefined;
  return {
    kind: RECALL_CAPTURE_KIND_BY_ORIGIN[input.origin],
    content: buildRecallCaptureContent(input),
    source: {
      origin: RECALL_CAPTURE_SOURCE_ORIGIN_BY_ORIGIN[input.origin],
      taskId: input.taskId,
      agentId: input.agentId,
      sessionId: input.sessionId,
    },
    tags: [...new Set([input.origin, ...sourceIdentifierTags(input), ...(input.tags ?? [])])],
    graphNodeIds,
  };
}

/**
 * Create the detached automatic-capture writer. Its drain is test-only: it exists so tests can
 * observe background writes without sleeps or polling.
 */
export function createRecallCaptureWriter(
  deps: RecallCaptureWriterDependencies,
): RecallCaptureWriterWithTestDrain {
  const pending = new Set<Promise<void>>();
  const append = deps.append ?? ((input: RecallAppendInput) => appendRecall(deps.layer, input));
  const recordAudit = async (type: "memory:capture-recorded" | "memory:capture-failed", input: RecallCaptureInput, metadata: Record<string, string>) => {
    const log = { warn: () => deps.logger.warn(`Automatic recall capture audit failed for ${input.origin}`) };
    if (deps.audit) {
      await emitBoundedRunAudit({
        recordRunAuditEvent: (event) => deps.audit?.({
          type: event.mutationType as "memory:capture-recorded" | "memory:capture-failed",
          metadata,
        }),
      }, { mutationType: type }, { log });
    } else if (!deps.append) {
      await emitBoundedRunAudit({
        recordRunAuditEvent: (event) => recordRunAuditEvent(deps.layer, event as RunAuditEventInput),
      }, {
        agentId: input.agentId ?? "memory-capture",
        runId: `memory-capture:${input.origin}:${Date.now()}`,
        taskId: input.taskId,
        domain: "database",
        mutationType: type,
        target: input.insightId ?? input.findingId ?? input.researchRunId ?? input.taskId ?? input.origin,
        metadata: { origin: input.origin, ...metadata },
      }, { log });
    }
  };

  return {
    capture(input) {
      const operation = (async () => {
        try {
          const result = await append(toAppendInput(input));
          await recordAudit("memory:capture-recorded", input, {
            recallRecordId: result.status === "created" ? result.record.id : result.duplicateOf.id,
            outcome: result.status,
          });
        } catch (error) {
          // Recall content can be sensitive, so diagnostics identify only the bounded origin.
          deps.logger.warn(`Automatic recall capture failed for ${input.origin}`);
          await recordAudit("memory:capture-failed", input, {
            errorClass: error instanceof Error ? error.name : "unknown",
          });
        }
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    },
    async flushPendingCaptures() {
      await Promise.all([...pending]);
    },
  };
}
