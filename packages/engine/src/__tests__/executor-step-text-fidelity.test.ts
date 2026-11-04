/*
FNXC:AssistantTextCapture 2026-09-13-21:15:
RUFU-234 executor-lane capture-consumer contract. The workflow-step session feeds TWO sinks from one
closure — `output += delta` (the string a prompt/verdict step persists and downstream gates parse) and
`agentLogger.onText(delta)` (the agent-log text rows) — so a capture-seam regression silently corrupts the
workflow verdict AND the operator-visible task log at once, and the two can drift apart. This drives the
real `executeWorkflowStep` with a real pi event stream (openai-completions producer shape: the shared
`partial` block is mutated ahead of async delivery, exactly what dropped the operator's inter-word space at
the seam) and asserts both sinks receive the intact text, identically.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

function captureMutatedAheadSession(finalText: string, firstChunk: string) {
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const partial = { content: [{ type: "text", text: firstChunk }] };
    const session: any = {
      state: {},
      subscribe: (fn: (event: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      },
      prompt: vi.fn(async () => {
        const emit = (assistantMessageEvent: Record<string, unknown>) => {
          for (const fn of listeners) fn({ type: "message_update", assistantMessageEvent });
        };
        listeners.forEach((fn) => fn({ type: "message_start" }));
        emit({ type: "text_start", partial, contentIndex: 0 });
        // The producer coalesced " in-review" into the block before the paired delta was delivered.
        partial.content[0].text = finalText;
        emit({ type: "text_delta", partial, contentIndex: 0, delta: finalText.slice(firstChunk.length + 1) });
        listeners.forEach((fn) =>
          fn({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } }),
        );
      }),
      dispose: vi.fn(),
    };
    return { session };
  });
}

function quietGit() {
  mockedExecSync.mockImplementation(() => Buffer.from(""));
}

function baseTask() {
  const now = new Date().toISOString();
  return {
    id: "FN-234-LANE",
    title: "Stream fidelity lane",
    description: "verify executor capture sinks",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-234-lane",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

function workflowStep() {
  const now = new Date().toISOString();
  return {
    id: "step:fidelity",
    name: "Fidelity Step",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Answer.",
    summaryTarget: "task" as const,
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("executeWorkflowStep — capture fan-out stays byte-faithful (RUFU-234)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  it("hands the workflow output and the agent-log rows the same intact text (no dropped space)", async () => {
    const intact = "healthy in-review";
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    const agentTextDeltas: string[] = [];
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
      onAgentText: (_taskId: string, delta: string) => { agentTextDeltas.push(delta); },
    } as any);
    captureMutatedAheadSession(intact, "healthy");

    const result = await (executor as any).executeWorkflowStep(baseTask(), workflowStep(), "/tmp/wt", {}, undefined, undefined);

    expect(result?.success).toBe(true);
    // Sink 1: the workflow verdict/output string downstream gates parse.
    expect(result.output).toBe(intact);
    // Sink 2: the agent-log lane, both as it streams per delta and as it persists text rows.
    expect(agentTextDeltas.join("")).toBe(intact);
    const batchCalls: any[][] = (store as any).appendAgentLogBatch?.mock?.calls ?? [];
    const singleCalls: any[][] = store.appendAgentLog?.mock?.calls ?? [];
    const persistedText = [
      ...batchCalls.flatMap(([entries]) => (entries ?? []).filter((entry: any) => entry.type === "text").map((entry: any) => String(entry.text))),
      ...singleCalls.filter(([, , type]) => type === "text").map(([, text]) => String(text)),
    ].join("");
    expect(persistedText).toBe(intact);
  });
});

/*
FNXC:AgentLogFidelity 2026-10-16-11:56:
RUFU-233 widened this RUFU-234 lane contract to the stream shapes the original single case did not cover:
several blocks in one message, a mutated-ahead lead at the coalescing window's own N=300 size delivered as
small chunks (a stream long enough to cross `FLUSH_SIZE_BYTES`, so the agent-log side lands as SEVERAL text
rows and a re-hand shows up as a duplicated run inside the row set), and a block revision that CONTRADICTS
the head this seam already handed — a shorter/trimmed terminal (`All done` / `Bash`, the operator signature
shapes) and a mid-text repair. The executor lane is the one lane whose captured text is ALSO the workflow
verdict downstream gates parse, so every case asserts both sinks: `result.output` and the persisted
agent-log rows.

Settings note: the cases below name an operator language so they exercise the directive-PRESENT branch of
the step prompt. They did not always have to. `executeWorkflowStep` built its step prompt with
`[configTime, buildOperatorLanguageDirective(settings)].filter((section) => section.trim())`, and that
helper returns `string | undefined` (unset/`"auto"` -> undefined), so a lane left on the schema default
threw `Cannot read properties of undefined (reading 'trim')` before any text streamed — which is why this
lane's fidelity contract had never actually run. RUFU-233 fixed that join (`.filter((section) =>
section?.trim())` in `execute-workflow-step.ts`), so the default is now a legal configuration and the
case at the top of this file plus the `"auto"` case below pin both spellings of that absence.

FNXC:AgentLogFidelity 2026-10-16-13:08:
Boundary of evidence for this file: the persisted rows are asserted at the store seam
(`store.appendAgentLogBatch` / `appendAgentLog` mock calls), NOT at `agent-log.jsonl`. `executor-test-helpers.ts`
mocks `node:fs` for the whole executor harness, so no real file boundary exists anywhere in this file — the
lane's rows are checked from the point the executor hands them off, which is where a capture or fan-out bug
can only occur. Bytes on disk are pinned by `agent-log-round-trip-fidelity.test.ts`, which drives the real
writer/reader with no fs mock, and the read route is ratcheted there too.
*/

type ScriptedBlock = { chunks: string[]; terminalText?: string };

/**
 * Script a pi session whose shared `partial` block is mutated AHEAD of the paired delta — the production
 * shape that dropped the operator's inter-word space — while the delivered `delta` stays the true
 * increment. `terminalText` replaces the block's text just before `text_end`, which is how a revision that
 * contradicts what was already streamed reaches the capture.
 */
function scriptMutatedAheadSession(blocks: ScriptedBlock[]): void {
  mockedCreateFnAgent.mockImplementation(async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const partial: { content: Array<{ type: string; text: string }> } = { content: [] };
    const emit = (assistantMessageEvent: Record<string, unknown>) => {
      for (const fn of listeners) fn({ type: "message_update", assistantMessageEvent });
    };
    const session: any = {
      state: {},
      subscribe: (fn: (event: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      },
      prompt: vi.fn(async () => {
        listeners.forEach((fn) => fn({ type: "message_start" }));
        const finished: Array<{ type: string; text: string }> = [];
        for (let contentIndex = 0; contentIndex < blocks.length; contentIndex++) {
          const block = blocks[contentIndex]!;
          partial.content[contentIndex] = { type: "text", text: "" };
          emit({ type: "text_start", partial, contentIndex });
          for (const chunk of block.chunks) {
            partial.content[contentIndex]!.text += chunk;
            emit({ type: "text_delta", partial, contentIndex, delta: chunk });
          }
          if (block.terminalText !== undefined) {
            partial.content[contentIndex]!.text = block.terminalText;
          }
          finished.push({ type: "text", text: partial.content[contentIndex]!.text });
          emit({ type: "text_end", partial, contentIndex });
        }
        listeners.forEach((fn) => fn({ type: "message_end", message: { role: "assistant", content: finished } }));
      }),
      dispose: vi.fn(),
    };
    return { session };
  });
}

/** A lane whose project settings name an operator language (see the settings note above). */
function configuredLane(settings: Record<string, unknown> = { operatorLanguage: "sk" }): { executor: TaskExecutor; store: ReturnType<typeof createMockStore> } {
  const store = createMockStore();
  store.getSettings.mockResolvedValue(settings);
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  return { executor, store };
}

/** The agent-log text rows this lane handed its store, in order. */
function persistedText(store: ReturnType<typeof createMockStore>): string {
  const batchCalls: any[][] = (store as any).appendAgentLogBatch?.mock?.calls ?? [];
  const singleCalls: any[][] = store.appendAgentLog?.mock?.calls ?? [];
  return [
    ...batchCalls.flatMap(([entries]) => (entries ?? [])
      .filter((entry: any) => entry.type === "text")
      .map((entry: any) => String(entry.text))),
    ...singleCalls.filter(([, , type]) => type === "text").map(([, text]) => String(text)),
  ].join("");
}

/**
 * The settings map is the FOURTH positional argument (`executeWorkflowStep(task, step, worktree, settings,…)`),
 * the raw project map the graph loads via `store.getSettings()`, so `operatorLanguage` has to be carried here —
 * `store.getSettings.mockResolvedValue(...)` does not reach this call.
 */
async function runLane(executor: TaskExecutor, settings: Record<string, unknown> = { operatorLanguage: "sk" }): Promise<{ success: boolean; output: string }> {
  return await (executor as any).executeWorkflowStep(
    baseTask(),
    workflowStep(),
    "/tmp/wt",
    settings,
    undefined,
    undefined,
  );
}

function occurrences(haystack: string, needle: string): number {
  return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

/**
 * Vitest truncates long string diffs, which is exactly the case here (a 1.6 KB stream), so the exact-equality
 * assertions carry their own first-divergence window.
 */
function diffAt(got: string, want: string): string {
  let i = 0;
  while (i < Math.min(got.length, want.length) && got.charCodeAt(i) === want.charCodeAt(i)) i++;
  const window = 28;
  return `len ${got.length} vs ${want.length}; first diff at ${i}: got ${JSON.stringify(got.slice(Math.max(0, i - window), i + window))} want ${JSON.stringify(want.slice(Math.max(0, i - window), i + window))}`;
}

describe("executeWorkflowStep — RUFU-233 lane parity across stream shapes", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  it("reassembles several blocks in order into both sinks", async () => {
    const { executor, store } = configuredLane();
    scriptMutatedAheadSession([
      { chunks: ["First block", " continues", " to the end."] },
      { chunks: ["Second block", " carries diacritits", " — riemelo_", " o tom."] },
      { chunks: ["Third", " one closes."] },
    ]);
    const expected =
      "First block continues to the end.Second block carries diacritits — riemelo_ o tom.Third one closes.";

    const result = await runLane(executor);

    expect(result?.success).toBe(true);
    expect(result.output, diffAt(result.output, expected.trimEnd())).toBe(expected.trimEnd());
    expect(persistedText(store), diffAt(persistedText(store), expected)).toBe(expected);
  });

  it("keeps a 300-byte mutated-ahead stream intact across the row boundary the flush threshold creates", async () => {
    const { executor, store } = configuredLane();
    const words = "kontrolujem tok textu przez capture seam pre dĺžku nad prah a skúšam duplicity".split(" ");
    const chunks: string[] = [];
    for (let i = 0; i < 300; i++) chunks.push(`${words[i % words.length]!} `);
    const streamed = chunks.join("");
    expect(streamed.length).toBeGreaterThan(1024);

    scriptMutatedAheadSession([{ chunks }]);

    const result = await runLane(executor);

    expect(result?.success).toBe(true);
    /*
    FNXC:AgentLogFidelity 2026-10-16-12:12:
    Measured here, and stated rather than assumed: the executor lane fans ONE hand-off into both sinks
    (`onText: (delta) => { output += delta; agentLogger.onText(delta); }`), so the two can never disagree in
    content. The one permitted difference is the step's own outcome contract, which trims the workflow
    verdict it returns — a trailing space survives into the agent-log rows and not into `result.output`.
    Every case below therefore asserts the agent-log side byte-exactly and the verdict side modulo that trim.
    */
    // Sink 1: the workflow verdict, trimmed by the step's own outcome contract.
    expect(result.output, diffAt(result.output, streamed)).toBe(streamed.trimEnd());
    // Sink 2: rows past FLUSH_SIZE_BYTES are several rows; their bytes must be exactly the stream.
    const persisted = persistedText(store);
    expect(persisted, diffAt(persisted, streamed)).toBe(streamed);
    for (const signature of ["All done.All done.", "BashBash", "UFU19 6"]) {
      expect(persisted).not.toContain(signature);
    }
  });

  it("hands a shorter/trimmed terminal revision once to both sinks, not the whole block again", async () => {
    const { executor, store } = configuredLane();
    const streamed = "All done. Let me summarize the user record.";
    scriptMutatedAheadSession([{ chunks: ["All done.", " Let me", " summarize", " the", " user", " record."], terminalText: "All done" }]);

    const result = await runLane(executor);

    expect(result?.success).toBe(true);
    const persisted = persistedText(store);
    // Exactly-once: the trimmed terminal must not re-hand the block head the row already carries.
    expect(occurrences(persisted, "All done")).toBe(1);
    // Losslessness: the prose that streamed before the revision survives, spaces included.
    expect(persisted).toContain("Let me summarize the user record.");
    expect(persisted.replace(/\s+/g, " ").trim()).toBe(streamed.replace(/\s+/g, " ").trim());
    // Sink 1 keeps its own raw-delta truth: the revision is block state, not a new delta.
    expect(result.output).toBe(streamed);
  });

  it("adds only the divergence run for a mid-text repair, once, in both sinks", async () => {
    const { executor, store } = configuredLane();
    scriptMutatedAheadSession([
      {
        chunks: ["All done", ". Let me", " summarize", " the", " result", "."],
        terminalText: "All done! Let me summarize the result.",
      },
    ]);

    const result = await runLane(executor);

    expect(result?.success).toBe(true);
    const persisted = persistedText(store);
    // The row keeps its original head (an append-only sink cannot rewrite it) and gains the divergence
    // span exactly once: `!` plus the tail past the common prefix.
    const handed = "All done. Let me summarize the result.! Let me summarize the result.";
    expect(occurrences(persisted, "! Let me summarize the result.")).toBe(1);
    expect(persisted, diffAt(persisted, handed)).toBe(handed);
    // One hand-off feeds both sinks, so the verdict carries the same divergence once — and the step's
    // outcome contract trims it, which is the only difference allowed between the two.
    expect(result.output, diffAt(result.output, handed.trimEnd())).toBe(handed.trimEnd());
  });

  /*
  FNXC:OperatorLanguage 2026-10-16-14:05:
  RUFU-233: the step session must reach its sinks on the DEFAULT operator language. `operatorLanguage`
  defaults to `"auto"` in `settings-schema.ts`, `buildOperatorLanguageDirective` emits nothing for it, and the
  step-prompt join used to call `.trim()` on that absence — so every workflow-step session of a default-
  language project died with `Cannot read properties of undefined (reading 'trim')` before a single delta
  streamed. This case is that crash's regression pin: it fails red on the unguarded join and green on the
  guarded one, and it asserts the text path rather than the error, because the point is that the lane runs.
  */
  it('streams intact text on the default operator language ("auto" emits no directive)', async () => {
    const intact = "Pripravené hodnoty boli overené.";
    const { executor, store } = configuredLane({ operatorLanguage: "auto" });
    scriptMutatedAheadSession([{ chunks: ["Pripravené", " hodnoty", " boli", " overené."] }]);

    const result = await runLane(executor, { operatorLanguage: "auto" });

    expect(result?.success, "step session must run with no operator-language directive").toBe(true);
    expect(persistedText(store), diffAt(persistedText(store), intact)).toBe(intact);
    expect(result.output, diffAt(result.output, intact)).toBe(intact);
  });
});
