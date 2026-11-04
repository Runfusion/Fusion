/*
FNXC:AgentLogFidelity 2026-10-16-11:37:
RUFU-233 three-lane parity — the TRIAGE (planner) lane. This lane writes the `text` rows an operator reads when a
card plans badly, and it is the lane whose rows this card's evidence came from. Before this file nothing asserted
what triage persists: `sessionTextTail` has a test (duplicate-marker recovery) but the log itself had none, and the
lane composes THREE layers between a delta and disk — the arrow's bounded tail accumulator, `AgentLogger`'s own
`onAgentText` observer (stuck-detector activity), and the logger's text buffer. Any of them could be the layer that
loses characters, so this file pins each one.

Step 6 feasibility-ladder record (rung reached: 2 + 3, not 1 — recorded here and in the diagnosis document):
  - Rung 1 (the real `TriageProcessor` planning run) is not reachable at a narrow seam: the arrow sits inside the
    planning method behind store/lock/worktree calls, and the capture is built by
    `createResolvedAgentSession` (`agents/agent-session-helpers.ts`), whose mocking is what existing triage suites do —
    which removes the seam under test.
  - The arrow is an inline closure over method-local state (`sessionTextTail`), so it cannot be imported (rung 2 pure form).
  - Pinned instead as: (a) STRUCTURAL on the lane's real source — the `onText` hook forwards its own parameter to the
    lane's `AgentLogger`, so the tail accumulator's `slice(-N)` cannot become the logged text, which is exactly the
    confusion the spec warns about; (b) BEHAVIOURAL on the lane's real composition — capture → (tail tee + logger with
    its `onAgentText` activity observer) → real `appendAgentLogEntriesSync` → real `readAgentLogEntries`.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import { appendAgentLogEntriesSync, readAgentLogEntries } from "../../../core/src/agents/agent-log-file-store.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import { createAssistantStreamProducer } from "./fixtures/assistant-stream-events.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TASK_ID = "RUFU-233-TRIAGE";
const triageSource = readFileSync(new URL("../triage.ts", import.meta.url), "utf8");

/**
 * The lane's tail bound is read from the lane's own source instead of being copied here, so the "a bounded tail
 * must not bound the log" test cannot quietly decay if the constant is ever retuned.
 */
function sessionTextTailChars(): number {
  const declared = /SESSION_TEXT_TAIL_CHARS\s*=\s*(\d+)/.exec(triageSource);
  if (!declared) throw new Error("triage's SESSION_TEXT_TAIL_CHARS is no longer declared — update this parity test");
  return Number(declared[1]);
}

/** Collapse to the non-whitespace skeleton: `normalizeStreamingDelta`'s whitespace insertion is the one permitted edit. */
const squash = (value: string): string => value.replace(/\s+/g, "");

const WORDS = [
  "Triage", "planned", "the", "card", "and", "streamed", "a", "long", "reply", "into", "the", "agent",
  "log", "while", "a", "bounded", "tail", "accumulator", "kept", "only", "the", "closing", "summary",
  "for", "duplicate", "marker", "recovery", "so", "the", "accumulator", "must", "never", "become",
  "the", "logged", "text", "including", "Slovak", "diacritics", "like", "Reštartuj", "vlastné", "čaká",
  "na", "výsledok", "príkaz", "bol", "úspešný",
];

function streamedChunks(rounds: number): string[] {
  const chunks: string[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const word of WORDS) {
      chunks.push(word);
      chunks.push(" ");
    }
  }
  return chunks;
}

describe("triage lane streamed-text fidelity (RUFU-233)", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "fusion-rufu233-triage-"));
  });
  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
  });

  function fileBackedStore(): TaskStore {
    const append = (
      entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"] }>,
    ) => appendAgentLogEntriesSync(taskDir, entries.map((entry) => ({ ...entry, timestamp: new Date().toISOString() })));
    return {
      appendAgentLog: async (
        taskId: string, text: string, type: AgentLogEntry["type"], detail?: string, agent?: AgentLogEntry["agent"],
      ) => append([{ taskId, text, type, detail, agent }]),
      appendAgentLogBatch: async (entries: Parameters<NonNullable<TaskStore["appendAgentLogBatch"]>>[0]) => append(entries),
    } as unknown as TaskStore;
  }

  /**
   * The triage lane's composition, transcribed from `triage.ts`: the bounded duplicate-marker tail tee, then the
   * logger — whose own `onAgentText` observer is the stuck-detector activity call. All three layers are under test.
   */
  function triagePipeline() {
    const tailBound = sessionTextTailChars();
    const handed: string[] = [];
    const observed: string[] = [];
    let sessionTextTail = "";
    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "triage",
      flushSizeBytes: 1,
      flushIntervalMs: 5,
      onAgentText: (_taskId, delta) => { observed.push(delta); },
    });
    const capture = createAssistantStreamCapture({
      onText: (text) => {
        sessionTextTail = `${sessionTextTail}${text}`.slice(-tailBound);
        handed.push(text);
        logger.onText(text);
      },
    });
    return {
      capture,
      logger,
      handed,
      observed,
      get sessionTextTail() { return sessionTextTail; },
      rows: () => readAgentLogEntries(taskDir, { type: "text" }).map((entry) => entry.text),
    };
  }

  async function drainWithLead(lane: ReturnType<typeof triagePipeline>, chunks: string[], revise?: (block: { text?: string }) => void) {
    const producer = createAssistantStreamProducer({ snapshot: "shared" });
    producer.messageStart();
    const index = producer.startBlock("text");
    const drain = () => { while (producer.queue.length > 0) lane.capture.handleAgentEvent(producer.queue.shift()); };
    drain();
    for (const chunk of chunks) {
      producer.delta("text", index, chunk);
      drain();
    }
    if (revise) revise(producer.message.content[index]);
    producer.endBlock("text", index);
    producer.messageEnd();
    drain();
    await lane.logger.flush();
    return producer.message.content[index].text ?? "";
  }

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:37:
  Half (a): the lane's own arrow. The forwarding argument must be the bare parameter, which is what proves the
  4 000-character `sessionTextTail` slice stays a side accumulator and never becomes the logged text — the exact
  substitution the task spec warns cannot be conflated.
  */
  it("triage's onText hook logs its own delta, not the bounded duplicate-marker tail", () => {
    const hookRe = /onText:\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*=>/g;
    const hooks = [...triageSource.matchAll(hookRe)];
    expect(hooks.length).toBeGreaterThanOrEqual(1);

    for (const hook of hooks) {
      const bodyStart = triageSource.indexOf("{", (hook.index ?? 0) + hook[0].length - 1);
      const body = triageSource.slice(bodyStart, bodyStart + 1_600);
      const forwarded = /agentLogger\??\.onText\(\s*([^)]*?)\s*\)/.exec(body);
      expect(forwarded, "triage's onText hook reached no AgentLogger").not.toBeNull();
      expect(forwarded![1]).toBe(hook[1]);
      expect(forwarded![1]).not.toContain("sessionTextTail");
      // The tail tee must sit in the arrow, or `sessionTextTail` would be dead and this guard would be vacuous.
      expect(body).toContain("sessionTextTail");
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:37:
  The lane's headline fidelity claim, at twice the tail bound: the accumulator may forget the opening of a long
  planning reply, the row may not. Also pins that the logger's activity observer sees the same deltas the row got,
  so the tee cannot be where a character disappears.
  */
  it("logs every character of a planning reply longer than its bounded session tail", async () => {
    const tailBound = sessionTextTailChars();
    const lane = triagePipeline();
    const chunks = streamedChunks(Math.ceil((tailBound * 2) / (WORDS.join(" ").length + 1)));
    const authoritative = await drainWithLead(lane, chunks);

    expect(authoritative.length).toBeGreaterThan(tailBound * 1.5);
    expect(lane.sessionTextTail.length).toBeLessThanOrEqual(tailBound);
    const onDisk = lane.rows().join("");
    expect(onDisk).toBe(lane.handed.join(""));
    expect(squash(onDisk)).toBe(squash(authoritative));
    expect(lane.observed.join("")).toBe(lane.handed.join(""));
    for (const word of ["Reštartuj", "Triage", "accumulator"]) {
      expect(onDisk).toContain(word);
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:37:
  The RUFU-233 duplicate-run class on this lane's sink in the operator's own shapes: a revision that names text the
  append-only row already holds adds nothing, so the row keeps the streamed text byte-for-byte up to permitted
  whitespace insertion and each opening run appears exactly once. Fails against the pre-fix whole-block hand-off.
  */
  it.each([
    { streamed: "All done. Let me summarize the record", revision: "All done" },
    { streamed: "Bash is restricted to the worktree", revision: "Bash" },
  ])("logs a trimmed block revision once: $revision stays once in agent-log.jsonl", async ({ streamed, revision }) => {
    const lane = triagePipeline();
    const authoritative = await drainWithLead(lane, streamed.split(/(?<= )/), (block) => {
      block.text = revision;
    });

    expect(authoritative).toBe(revision);
    const onDisk = lane.rows().join("");
    expect(onDisk).toBe(lane.handed.join(""));
    expect(squash(onDisk)).toBe(squash(streamed));
    expect(onDisk.match(new RegExp(revision, "g")) ?? []).toHaveLength(1);
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:37:
  A mid-text repair is the one revision an append-only row cannot absorb: the row keeps its head and gains the
  divergence run once. The tail accumulator must see the same handed text, so duplicate-marker recovery keeps
  working on the revised stream even though the row cannot be rewritten.
  */
  it("adds only the divergence run when a repair changes text mid-block", async () => {
    const lane = triagePipeline();
    const streamed = "All done. Let me summarize the record";
    const revised = "All done! Let me summarize the record";
    const authoritative = await drainWithLead(lane, streamed.split(/(?<= )/), (block) => {
      block.text = revised;
    });

    expect(authoritative).toBe(revised);
    const onDisk = lane.rows().join("");
    expect(onDisk).toBe(lane.handed.join(""));
    expect(squash(onDisk)).toBe(squash(`${streamed}${revised.slice("All done".length)}`));
    expect(onDisk.match(/All done/g) ?? []).toHaveLength(1);
    expect(onDisk.match(/! Let me summarize/g) ?? []).toHaveLength(1);
    expect(lane.observed.join("")).toBe(lane.handed.join(""));
  });
});
