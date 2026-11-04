/*
FNXC:AgentLogging 2026-10-16-09:37:
RUFU-233 read-route/file-store exoneration ratchet. The operator-reported corruption (scattered 1-4
character drops, lost inter-word spaces, a duplicated opening run) named three candidate layers: the
capture seam, the agent-log read route, and the JSONL file writer. RUFU-208 already pinned the read
route's selection algebra and framing (offset/limit/type/time-window/pagination and newline/line-number
integrity), so what nothing pinned was the ONE claim an operator actually makes: "the characters my
session streamed are the characters in `agent-log.jsonl`". A selection-algebra suite can be green while
every assistant row is silently mangled, because it asserts how rows are *chosen*, never what a row
*contains*. This suite closes that gap on the real pipeline — real `createAssistantStreamCapture` → real
`AgentLogger` → real `appendAgentLogEntriesSync` → real `readAgentLogEntries`, with no mock between the
streamed delta and the bytes on disk — and asserts two invariants separately so a future failure names
its own layer:
  (a) disk fidelity: the `text` rows read back, concatenated, equal EXACTLY the strings handed to
      `AgentLogger.onText` (zero tolerance — write/read may not add, drop, or reorder a byte);
  (b) capture fidelity: those handed strings equal the block's final authoritative text with whitespace
      insertion by `normalizeStreamingDelta` the only permitted difference (the RUFU-234 contract).
FNXC:AgentLogging 2026-10-16-09:37:
The branch-a4 case is the cross-runtime-fallback exoneration. `withRuntimeEventCallbacks` drives BOTH
the pi-shaped event surface and the lane callback for a callbacks-only runtime, and lanes subscribe a
capture whose sinks ARE lane callbacks. Those two surfaces must never both reach one sink:
`execute-workflow-step.ts` subscribes a capture and passes NO lane `onText`, while
`run-implementation.ts` passes `onText: agentLogger.onText` and subscribes nothing. Each reachable
consumer shape therefore gets every delta exactly once; pinning both is what keeps a future lane that
wires BOTH from silently reintroducing the operator's "All done. All done." duplication.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import {
  appendAgentLogEntriesSync,
  readAgentLogEntries,
} from "../../../core/src/agents/agent-log-file-store.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import { withRuntimeEventCallbacks } from "../agents/cross-runtime-fallback.js";
import { createAssistantStreamProducer } from "./fixtures/assistant-stream-events.js";
import {
  AGENT_LOG_READ_DETAIL_PREVIEW_MAX,
  buildTaskAgentLogReadText,
  renderAgentLogEntries,
} from "../agent-tools.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TASK_ID = "RUFU-233";

/** Collapse to the non-whitespace skeleton: whitespace insertion is the one permitted capture edit. */
const squash = (value: string): string => value.replace(/\s+/g, "");

const WORDS = [
  "The", "executor", "streamed", "a", "long", "assistant", "reply", "across", "many", "small",
  "deltas", "so", "the", "buffer", "would", "inevitably", "cross", "its", "flush", "boundary",
  "mid", "token", "and", "prove", "whether", "persistence", "preserves", "every", "single",
  "character", "of", "the", "authoritative", "block", "text", "including", "Slovak", "diacritics",
  "like", "Reštartuj", "a", "vlastné", "čaká", "na", "výsledok", "príkaz", "bol", "úspešný",
];

/** ~1.2 KB of real prose, including Slovak diacritics, split into word/space deltas. */
function streamedChunks(): string[] {
  const chunks: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (const word of WORDS) {
      chunks.push(word);
      chunks.push(" ");
    }
  }
  return chunks;
}

describe("agent-log byte round-trip fidelity (RUFU-233)", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "fusion-rufu233-agent-log-"));
  });
  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  /** A store port backed by the production JSONL writer/reader (the FN-431 harness shape). */
  function fileBackedStore(): TaskStore {
    const append = (
      entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"] }>,
    ) => {
      appendAgentLogEntriesSync(taskDir, entries.map((entry) => ({ ...entry, timestamp: new Date().toISOString() })));
    };
    return {
      appendAgentLog: async (
        taskId: string, text: string, type: AgentLogEntry["type"], detail?: string, agent?: AgentLogEntry["agent"],
      ) => append([{ taskId, text, type, detail, agent }]),
      appendAgentLogBatch: async (entries: Parameters<NonNullable<TaskStore["appendAgentLogBatch"]>>[0]) => append(entries),
    } as unknown as TaskStore;
  }

  /**
   * Real capture → real logger → real JSONL → real reader. Records what the capture handed the logger
   * so invariant (a) can be checked with zero tolerance against what came back off disk.
   */
  function buildPipeline(options: { flushSizeBytes?: number; flushIntervalMs?: number } = {}) {
    const handed: string[] = [];
    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "executor",
      flushSizeBytes: options.flushSizeBytes ?? 1024,
      flushIntervalMs: options.flushIntervalMs ?? 500,
    });
    const capture = createAssistantStreamCapture({
      onText: (delta) => {
        handed.push(delta);
        logger.onText(delta);
      },
    });
    return {
      logger,
      capture,
      handed,
      rows: () => readAgentLogEntries(taskDir, { type: "text" }).map((entry) => entry.text),
      raw: () => readFileSync(join(taskDir, "agent-log.jsonl"), "utf8"),
    };
  }

  /**
   * Drives the pi shared-partial producer with a bounded mutation-ahead lead — the RUFU-234 race, in
   * which the producer is `lead` deltas into the shared block before the consumer has drained the delta
   * being delivered. The fixture mutates the block when `delta()` is CALLED, so the lead only exists if
   * production and draining are interleaved: produce a batch of `lead` deltas, then drain that batch.
   */
  function drainWithLead(
    capture: ReturnType<typeof createAssistantStreamCapture>,
    producer: ReturnType<typeof createAssistantStreamProducer>,
    chunks: string[],
    lead: number,
  ): void {
    const drain = () => {
      while (producer.queue.length > 0) capture.handleAgentEvent(producer.queue.shift());
    };
    producer.messageStart();
    const index = producer.startBlock("text");
    drain();
    for (let i = 0; i < chunks.length; i += lead) {
      for (const chunk of chunks.slice(i, i + lead)) producer.delta("text", index, chunk);
      drain();
    }
    producer.endBlock("text", index);
    producer.messageEnd();
    drain();
  }

  it("round-trips a >1KB streamed block through JSONL byte-identically", async () => {
    const pipeline = buildPipeline();
    const producer = createAssistantStreamProducer();
    const chunks = streamedChunks();
    drainWithLead(pipeline.capture, producer, chunks, 2);
    await pipeline.logger.flush();

    const finalText = chunks.join("");
    // (a) disk fidelity, zero tolerance: read-back == exactly what was handed to the logger.
    expect(pipeline.rows().join("")).toBe(pipeline.handed.join(""));
    // This is a multi-delivery, multi-row round-trip, not one write that trivially matches itself.
    expect(pipeline.handed.length).toBeGreaterThan(1);
    expect(pipeline.rows().length).toBeGreaterThan(1);
    // (b) capture fidelity: whitespace insertion is the only permitted difference from the real block text.
    expect(squash(pipeline.handed.join(""))).toBe(squash(finalText));
    expect(finalText.length).toBeGreaterThan(1024);
    // Every persisted row is a non-empty payload: no blank/whitespace-only sentinel row was written.
    expect(pipeline.rows().every((row) => row.length > 0)).toBe(true);
  });

  it("reassembles a token that straddles two rows across the row boundary", async () => {
    // Threshold of 1 byte puts consecutive deliveries in consecutive rows, so a token is split across a
    // boundary exactly as a real mid-token flush splits it. Lead 1 keeps the block one delta ahead, so
    // the capture emits per-delta spans instead of the whole block in one delivery.
    const pipeline = buildPipeline({ flushSizeBytes: 1, flushIntervalMs: 5 });
    const producer = createAssistantStreamProducer();
    drainWithLead(pipeline.capture, producer, ["Reš", "tar", "tuj", " ", "použ", "it", "ý"], 1);
    await pipeline.logger.flush();

    const rows = pipeline.rows();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join("")).toBe(pipeline.handed.join(""));
    // Some row ends inside the token and the next one continues it — the straddle really happened.
    // (Two adjacent rows that join with no whitespace between them are by construction one token.)
    const straddled = rows.some((row, i) =>
      i + 1 < rows.length && /[^\s]$/.test(row) && /^[^\s]/.test(rows[i + 1] ?? ""));
    expect(straddled).toBe(true);
    expect(squash(rows.join(""))).toBe(squash("Reštartuj použitý"));
  });

  it("keeps interleaved status and tool rows byte-clean beside the text rows", async () => {
    const pipeline = buildPipeline({ flushSizeBytes: 1, flushIntervalMs: 5 });
    const producer = createAssistantStreamProducer();
    producer.messageStart();
    const index = producer.startBlock("text");
    for (const chunk of ["Reštartuj", " ", "použit", "ý"]) producer.delta("text", index, chunk);
    producer.drain(pipeline.capture.handleAgentEvent);
    pipeline.logger.onToolStart("Bash", { command: "pnpm test" });
    // A status row is authored outside the logger (the executor writes it), so append it the way the
    // engine does: straight through the same real file-store entry point.
    appendAgentLogEntriesSync(taskDir, [{
      timestamp: new Date().toISOString(),
      taskId: TASK_ID,
      text: "step 1 done",
      type: "status",
      agent: "executor",
    }]);
    for (const chunk of [" hotový"]) producer.delta("text", index, chunk);
    producer.endBlock("text", index);
    producer.messageEnd();
    producer.drain(pipeline.capture.handleAgentEvent);
    await pipeline.logger.flush();

    const text = readAgentLogEntries(taskDir, { type: "text" }).map((e) => e.text);
    const status = readAgentLogEntries(taskDir, { type: "status" }).map((e) => e.text);
    const tool = readAgentLogEntries(taskDir, { type: "tool" }).map((e) => e.text);
    expect(text.join("")).toBe(pipeline.handed.join(""));
    expect(status).toEqual(["step 1 done"]);
    // The tool row keeps its name as text and its arguments in `detail` — neither bleeds into text rows.
    expect(tool).toEqual(["Bash"]);
    // The control rows are byte-clean and JSON-parseable in the same file as the streamed rows.
    const lines = pipeline.raw().split("\n").filter((line) => line.trim().length > 0);
    expect(() => lines.forEach((line) => JSON.parse(line))).not.toThrow();
  });

  it("writes identical bytes through the 500ms timer flush (fake timers)", async () => {
    vi.useFakeTimers();
    const pipeline = buildPipeline({ flushSizeBytes: 1_000_000, flushIntervalMs: 500 });
    const producer = createAssistantStreamProducer();
    const chunks = streamedChunks();
    drainWithLead(pipeline.capture, producer, chunks, 2);
    // Force the timer path rather than the size path: nothing crossed the byte threshold.
    await vi.advanceTimersByTimeAsync(500);
    await pipeline.logger.flush();

    expect(pipeline.rows().length).toBeGreaterThan(0);
    expect(pipeline.rows().join("")).toBe(pipeline.handed.join(""));
    expect(squash(pipeline.handed.join(""))).toBe(squash(chunks.join("")));
  });

  it("delivers each fallback-bridge delta exactly once on both reachable consumer shapes (branch a4)", () => {
    // Shape 1 — `execute-workflow-step.ts`: the lane subscribes a capture and passes NO lane `onText`,
    // so the bridged event surface is the only live surface.
    const captured: string[] = [];
    const handlers: Array<(event: unknown) => void> = [];
    const bridgedSubscriber = withRuntimeEventCallbacks({}, (event) => {
      for (const handler of handlers) handler(event);
    });
    const capture = createAssistantStreamCapture({ onText: (delta) => captured.push(delta) });
    handlers.push((event) => capture.handleAgentEvent(event));
    for (const delta of ["All done", ". ", "Bash", " ran"]) bridgedSubscriber.onText?.(delta);
    expect(captured).toEqual(["All done", ". ", "Bash", " ran"]);

    // Shape 2 — `run-implementation.ts`: the lane passes `onText: agentLogger.onText` and subscribes
    // nothing, so the direct forward is the only live surface.
    const terminal: string[] = [];
    const emit = vi.fn();
    const bridgedCallback = withRuntimeEventCallbacks({ onText: (delta) => terminal.push(delta) }, emit);
    for (const delta of ["All done", ". ", "Bash", " ran"]) bridgedCallback.onText?.(delta);
    expect(terminal).toEqual(["All done", ". ", "Bash", " ran"]);
  });

  it("keeps whitespace insertion as the only permitted difference (independent recomputation)", async () => {
    const pipeline = buildPipeline({ flushSizeBytes: 64 });
    const producer = createAssistantStreamProducer();
    const chunks = ["Reštartuj", " ", "použit", "ý", " ", "vlastné", "udy", " ", "čaká"];
    drainWithLead(pipeline.capture, producer, chunks, 1);
    await pipeline.logger.flush();

    const observed = pipeline.handed.join("");
    const finalText = chunks.join("");
    // The capture may only INSERT a sentence-boundary space: nothing may be dropped or duplicated, so
    // recomputing both ways must land on the same answer.
    expect(squash(observed)).toBe(squash(finalText));
    expect(observed.length).toBeGreaterThanOrEqual(finalText.length);
    for (const delta of pipeline.handed) expect(delta.length).toBeGreaterThan(0);
    // And the file agrees with the sink byte for byte.
    expect(pipeline.rows().join("")).toBe(observed);
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-13:08:
  RUFU-233 §8.1 promises the read route is RATCHETED, not re-investigated — the disk evidence put the
  holes upstream of it, so what is owed is a guard that a future change cannot make it lossy. Nothing
  covered `buildTaskAgentLogReadText`/`renderAgentLogEntries` with fidelity before this card (only
  selection algebra in RUFU-208 and `vi.fn(() => "")` stubs in the CLI lane), so a row that survived
  the JSONL boundary could still be mangled on its way to the operator. The read route's ONLY permitted
  content reductions are its documented whole-payload budget (`trimSemanticToolRead`, 12 000 chars) and
  the documented `detail` preview; neither may edit the inside of a `text` value. These two cases close
  the audit findings on this card: the rendered payload must carry every persisted row verbatim.
  */
  it("renders every persisted text row byte-exactly through the operator read route", async () => {
    const pipeline = buildPipeline({ flushSizeBytes: 64 });
    const producer = createAssistantStreamProducer();
    drainWithLead(pipeline.capture, producer, streamedChunks(), 2);
    await pipeline.logger.flush();

    const rows = pipeline.rows();
    const entries = readAgentLogEntries(taskDir, { type: "text" });
    const payload = buildTaskAgentLogReadText(entries, {
      taskId: TASK_ID,
      total: entries.length,
      limit: entries.length,
      offset: 0,
      detail: "full",
    });

    // Zero tolerance per row: a stored `text` must appear in the rendered payload verbatim.
    for (const row of rows) expect(payload).toContain(row);
    // Order is preserved and each row is its own rendered block, so walking the payload left to right
    // must find the rows in the order the session streamed them. A cursor (not a bare `indexOf`) is
    // required because a flush-split fragment row can also occur as a substring inside an earlier row.
    let cursor = 0;
    for (const row of rows) {
      const at = payload.indexOf(row, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + row.length;
    }
    // The whole-payload budget is the only thing allowed to shorten this answer, and this payload is
    // nowhere near it — so a truncation marker here would mean the route dropped content silently.
    expect(payload).not.toContain("[Output truncated;");
    expect(rows.join("").length).toBeLessThan(12_000);
    // The direct renderer agrees with the tool payload on every row (one shared formatter, two entry points).
    const rendered = renderAgentLogEntries(entries);
    for (const row of rows) expect(rendered).toContain(row);
  });

  it("previews a long detail without touching that row's text", async () => {
    const pipeline = buildPipeline({ flushSizeBytes: 64 });
    const producer = createAssistantStreamProducer();
    drainWithLead(pipeline.capture, producer, ["Reštartuj", " ", "použit", "ý", " ", "vlastné"], 1);
    await pipeline.logger.flush();
    const streamedRows = pipeline.rows();

    // A row whose `detail` is over the preview budget, written through the production writer.
    appendAgentLogEntriesSync(taskDir, [{
      taskId: TASK_ID,
      type: "text",
      text: "Detail-heavy row: fn_task_logs_read /home/schindler",
      detail: "x".repeat(AGENT_LOG_READ_DETAIL_PREVIEW_MAX + 300),
      agent: "executor",
      timestamp: new Date().toISOString(),
    }]);
    const entries = readAgentLogEntries(taskDir, { type: "text" });

    const preview = buildTaskAgentLogReadText(entries, {
      taskId: TASK_ID,
      total: entries.length,
      limit: entries.length,
      offset: 0,
    });
    // The preview is real (detail shortened) but never reaches into `text`: every streamed row survives
    // the preview mode byte-exactly, diacritics and token-internal characters included.
    expect(preview).toContain("[Detail preview truncated:");
    for (const row of streamedRows) expect(preview).toContain(row);
    expect(preview).toContain("fn_task_logs_read /home/schindler");
    // `detail: "full"` is the documented way to get the rest, and it does not shorten the detail either.
    const full = buildTaskAgentLogReadText(entries, {
      taskId: TASK_ID,
      total: entries.length,
      limit: entries.length,
      offset: 0,
      detail: "full",
    });
    expect(full).not.toContain("[Detail preview truncated:");
    expect(full).toContain("x".repeat(AGENT_LOG_READ_DETAIL_PREVIEW_MAX + 300));
  });
});
