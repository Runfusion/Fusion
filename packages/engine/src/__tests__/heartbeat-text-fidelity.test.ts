/*
FNXC:AgentLogFidelity 2026-10-16-11:34:
RUFU-233 three-lane parity — the HEARTBEAT lane. The operator-reported corruption was seen on this lane's own
output (a `text` row of RUFU-196's heartbeat run), and before this file no heartbeat test asserted what lands in
`agent-log.jsonl`: `heartbeat-executor.test.ts` mocks `../pi.js` wholesale, and `agent-heartbeat.ts` builds its
`AgentLogger` beside the session, so the streamed→persisted boundary was untested for the one lane that runs
unattended all night.

Step 6 feasibility-ladder record ( rung reached: 2 + 3, not 1 — recorded here and in the diagnosis document):
  - Rung 1 (full lane entry point) is not reachable at a narrow seam. The heartbeat tick that reaches this arrow
    lives behind store budget/inbox/worktree calls, and its runtime boundary is `createResolvedAgentSession`
    (`agents/agent-session-helpers.ts`), which is where the capture is constructed — mocking it, as the existing
    heartbeat suite does, deletes the seam under test rather than isolating it.
  - The lane's `onText` arrow is an inline closure inside a single-use block of a ~5,000-line class, so the exact
    arrow cannot be imported and driven (rung 2 in its pure form).
  - So the invariant is pinned in the two halves that compose it, each at the narrowest real seam:
      (a) STRUCTURAL, against the lane's real source — every `onText` hook forwards its OWN parameter to the lane's
          `AgentLogger`, with nothing between them able to drop or rewrite a character;
      (b) BEHAVIOURAL, on the lane's real sink shape — capture → the lane's composition (gate + length counter +
          logger) → real `AgentLogger` → real `appendAgentLogEntriesSync` → real `readAgentLogEntries`.
    The gate and the counter are part of the composition under test, not excluded from it, so a gate that ate a
    delta or a counter that truncated it would fail (b).
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

const TASK_ID = "RUFU-233-HB";

/** Collapse to the non-whitespace skeleton: `normalizeStreamingDelta`'s whitespace insertion is the one permitted edit. */
const squash = (value: string): string => value.replace(/\s+/g, "");

const WORDS = [
  "Heartbeat", "tick", "streamed", "a", "long", "assistant", "reply", "through", "the", "lane", "arrow",
  "into", "an", "append-only", "logger", "while", "the", "producer", "ran", "ahead", "of", "the", "consumer",
  "so", "a", "flush", "cut", "would", "land", "mid", "token", "and", "prove", "whether", "persistence",
  "keeps", "every", "byte", "including", "Slovak", "diacritics", "like", "Reštartuj", "vlastné", "čaká",
  "na", "výsledok", "príkaz", "bol", "úspešný", "a", "pokračuje", "ďalej",
];

/** ~700 words of prose with diacritics, split into word/space deltas so the 1 KB flush boundary is crossed mid-token. */
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

/**
 * Escape-hatch marker for the structural half of this contract: a capture hook that intentionally writes no
 * agent-log row may opt out of the forwarding rule by naming why in a `// agent-log-fidelity-allowlist:` comment
 * placed directly on its own statement. The marker is required rather than inferred from "this hook happens to
 * mention no logger", because "a hook that forgot the logger" is exactly the regression this scan exists to catch,
 * and inferring the exemption from the absence of a logger would make that regression invisible.
 *
 * FNXC:AgentLogFidelity 2026-11-04-00:21 (RUFU-233 merge reconciliation):
 * main landed RUFU-268's idle-preflight turn (`runIdlePreflightTurn`), a third `onText` hook in this file that
 * accumulates a one-line YES/NO verdict into memory and deliberately persists nothing. This scan was written
 * against the two agent-log sites that existed when RUFU-233 branched, so the new memory-only site made it fail
 * on a premise it never made. The exemption is scoped to a single marked site, not to "hooks without a logger".
 */
const ALLOWLIST_MARKER = "// agent-log-fidelity-allowlist:";

/** The statement a hook sits in: from the previous terminator (or blank line) to the next semicolon. */
function statementWindow(source: string, at: number): string {
  const start = Math.max(source.lastIndexOf(";", at), source.lastIndexOf("\n\n", at)) + 1;
  const next = source.indexOf(";", at);
  return source.slice(start, next === -1 ? source.length : next);
}

/**
 * Every `onText:` arrow in a lane's source, reduced to (declared parameter, forwarded argument, whether a logger
 * call exists, whether the site is allowlisted as logger-free). The argument is captured from the forwarding call
 * itself, so any `slice`/`replace`/template reconstruction between the delta and the logger shows up as a mismatch
 * against the parameter.
 */
function onTextWiring(source: string, loggerCall: RegExp): Array<{ param: string; forwards: boolean; arg: string | null; exempt: boolean; at: number }> {
  const hooks: Array<{ param: string; forwards: boolean; arg: string | null; exempt: boolean; at: number }> = [];
  const hookRe = /onText:\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)|([A-Za-z_$][\w$]*))\s*=>/g;
  for (const match of source.matchAll(hookRe)) {
    const param = match[1] ?? match[2];
    const at = match.index ?? 0;
    const bodyStart = source.indexOf("{", at + match[0].length - 1);
    const body = bodyStart === -1 ? "" : source.slice(bodyStart, bodyStart + 1_200);
    const preceding = source.slice(Math.max(0, at - 400), at);
    const markerAt = preceding.lastIndexOf(ALLOWLIST_MARKER);
    // The marker only exempts the statement it is written on — a `}` or `;` after it means it belongs to an earlier one.
    const exempt = markerAt !== -1 && !/[;}]/.test(preceding.slice(markerAt + ALLOWLIST_MARKER.length));
    const forwarded = loggerCall.exec(body);
    hooks.push({ param, forwards: Boolean(forwarded), arg: forwarded?.[1] ?? null, exempt, at });
  }
  return hooks;
}

describe("heartbeat lane streamed-text fidelity (RUFU-233)", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "fusion-rufu233-heartbeat-"));
  });
  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
  });

  /** A store port backed by the production JSONL writer/reader — the lane's real persistence path. */
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
   * The heartbeat lane's sink composition, transcribed from `agent-heartbeat.ts`: the `acceptsRunEvent()` gate,
   * the `outputLength` counter, then the logger. Those two statements are why this is a lane test and not a
   * re-run of the shared seam: they are the only code between a delta and the log.
   */
  function heartbeatPipeline(options: { acceptsRunEvent?: () => boolean } = {}) {
    const handed: string[] = [];
    let outputLength = 0;
    const acceptsRunEvent = options.acceptsRunEvent ?? (() => true);
    const logger = new AgentLogger({
      store: fileBackedStore(),
      taskId: TASK_ID,
      agent: "executor",
      flushSizeBytes: 1,
      flushIntervalMs: 5,
    });
    const capture = createAssistantStreamCapture({
      onText: (delta) => {
        if (!acceptsRunEvent()) return;
        outputLength += delta.length;
        handed.push(delta);
        logger.onText(delta);
      },
    });
    return {
      capture,
      logger,
      handed,
      get outputLength() { return outputLength; },
      rows: () => readAgentLogEntries(taskDir, { type: "text" }).map((entry) => entry.text),
    };
  }

  /** Produce one delta, then drain what is queued — the lead-1 mutated-ahead interleaving pi actually exhibits. */
  async function drainWithLead(lane: ReturnType<typeof heartbeatPipeline>, chunks: string[], revise?: (block: { text?: string }) => void) {
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
  FNXC:AgentLogFidelity 2026-10-16-11:34:
  Half (a) of the ladder record: the lane's own arrows. Both heartbeat agent-log sites (the main run and the
  validator run) must forward their delta parameter to the lane's logger — a hook that forgets the logger, or
  forwards a modified string, is exactly how a character-loss class becomes lane-specific.

  FNXC:AgentLogFidelity 2026-11-04-00:21 (RUFU-233 merge reconciliation):
  A capture hook that persists nothing is not an agent-log site, and RUFU-268's idle-preflight hook is one — it
  opts out through the allowlist marker at its own statement, and its exemption is checked by asserting the site
  writes no agent-log row.
  */
  it("every heartbeat onText hook forwards its own delta parameter to the lane's AgentLogger", () => {
    const source = readFileSync(new URL("../agent-heartbeat.ts", import.meta.url), "utf8");
    const hooks = onTextWiring(source, /agentLogger\??\.onText\(\s*([^)]*?)\s*\)/);

    const agentLogSites = hooks.filter((hook) => !hook.exempt);
    expect(agentLogSites.length).toBeGreaterThanOrEqual(2);
    for (const hook of agentLogSites) {
      expect(hook.forwards, "an onText hook reached no AgentLogger").toBe(true);
      expect(hook.arg, "the logger argument is no longer the bare delta").toBe(hook.param);
    }
    // An exemption is a claim that the site persists nothing, so a marked site may not write the log anywhere
    // inside its own statement (the window that actually holds the capture construction and its hooks).
    for (const hook of hooks.filter((h) => h.exempt)) {
      expect(statementWindow(source, hook.at)).not.toMatch(/agentLogger\s*\??\.onText\(/);
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:34:
  Half (b), the symptom shape: a ~700-word block streamed through mutated-ahead deltas while `flushSizeBytes: 1`
  forces a row boundary inside every token. Invariant (a) zero-tolerance: disk equals what was handed.
  Invariant (b): what was handed equals the block's final text up to permitted whitespace insertion, and the
  operator's signature (a hole inside a word) cannot appear.
  */
  it("writes the same text it streamed — mutated-ahead, diacritic-bearing, flush boundary crossed", async () => {
    const lane = heartbeatPipeline();
    const chunks = streamedChunks();
    const authoritative = await drainWithLead(lane, chunks);

    const onDisk = lane.rows().join("");
    const handed = lane.handed.join("");
    expect(onDisk).toBe(handed);
    expect(squash(onDisk)).toBe(squash(authoritative));
    expect(lane.outputLength).toBe(lane.handed.join("").length);
    for (const word of ["Reštartuj", "vlastné", "Heartbeat", "persistence"]) {
      expect(onDisk).toContain(word);
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:34:
  The RUFU-233 duplicate-run class on this lane's sink, in the operator's own two shapes. Both rows arrived because a
  block revision re-handed a head the append-only row already held: `All done.All done.` and `BashBash is restricted`.
  The revision names text the row ALREADY holds, so the durable-correct outcome is that the row keeps the streamed
  text and gains nothing — byte-for-byte equality with what was streamed is therefore assertable here with zero
  tolerance, and it fails against the pre-fix whole-block hand-off.
  */
  it.each([
    { streamed: "All done. Let me summarize the record", revision: "All done" },
    { streamed: "Bash is restricted to the worktree", revision: "Bash" },
  ])("writes a trimmed block revision once: $revision stays once in agent-log.jsonl", async ({ streamed, revision }) => {
    const lane = heartbeatPipeline();
    const authoritative = await drainWithLead(lane, streamed.split(/(?<= )/), (block) => {
      block.text = revision;
    });

    expect(authoritative).toBe(revision);
    const onDisk = lane.rows().join("");
    expect(squash(onDisk)).toBe(squash(streamed));
    expect(onDisk.match(new RegExp(revision, "g")) ?? []).toHaveLength(1);
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:34:
  The one revision an append-only row cannot absorb: a repair that diverges MID-text (`.` → `!`). The row keeps its
  unrecoverable head and gains the divergence run exactly once — that is the floor, so the lane test pins the floor
  rather than pretending the row can be rewritten. Duplicating the head (the pre-fix behavior) is the failure mode.
  */
  it("adds only the divergence run when a repair changes text mid-block", async () => {
    const lane = heartbeatPipeline();
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
    // The added span is the divergence run and it may appear exactly once; its phrase also sits in the
    // unrecoverable head the row already held, which is why the run — not the phrase — is what gets counted.
    expect(onDisk.match(/! Let me summarize/g) ?? []).toHaveLength(1);
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:34:
  The gate half of the composition: once the run stops accepting events the lane legitimately drops text. That
  must be the ONLY reason a delta is missing from the row — a gate that mis-fires mid-run is the same operator-visible
  symptom, so the test pins both sides of the gate in one run.
  */
  it("drops deltas only while its run gate is closed, and every delta once the gate is open", async () => {
    let gateOpen = true;
    const lane = heartbeatPipeline({ acceptsRunEvent: () => gateOpen });
    const chunks = ["First", " ", "half", " ", "second", " ", "half"];
    const producer = createAssistantStreamProducer({ snapshot: "shared" });
    producer.messageStart();
    const index = producer.startBlock("text");
    const drain = () => { while (producer.queue.length > 0) lane.capture.handleAgentEvent(producer.queue.shift()); };
    drain();
    for (let i = 0; i < chunks.length; i++) {
      if (i === 4) gateOpen = false;
      producer.delta("text", index, chunks[i]);
      drain();
    }
    gateOpen = true;
    producer.endBlock("text", index);
    producer.messageEnd();
    drain();
    await lane.logger.flush();

    const onDisk = lane.rows().join("");
    // The gate closed for `second`, so that span is the lane's own deliberate drop and nothing else is missing.
    expect(squash(onDisk)).toContain(squash("First half"));
    expect(onDisk).not.toContain("halfhalf");
    expect(lane.handed.join("").length).toBe(lane.outputLength);
    expect(onDisk).toBe(lane.handed.join(""));
  });
});
