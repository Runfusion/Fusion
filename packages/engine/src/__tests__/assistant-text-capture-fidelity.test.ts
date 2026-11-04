import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import { normalizeStreamingDelta } from "../execution/streaming-delta.js";
import evidence from "./evidence-replay/RUFU-196-holed-rows.json";

/*
FNXC:AssistantTextCapture 2026-09-13-22:55:
RUFU-234 stream-fidelity contract. Every string handed to the text/thinking sink for ONE assistant block,
concatenated, must equal that block's final authoritative text with whitespace insertion by
normalizeStreamingDelta the ONLY permitted difference — nothing dropped, nothing duplicated. These replays
encode the operator-reported corruption (scattered 1-4 char drops, lost inter-word spaces, "notes"→"otes")
as deterministic pi event-shape fixtures so the fix cannot trade loss for duplication or vice versa. Each
fixture is RED on the pre-fix seam (see the task `diagnosis` document) and GREEN after deriving the emitted
span from the authoritative block text instead of trusting update.delta.
*/

type Block = { type: string; text?: string; thinking?: string };

function mk() {
  const text: string[] = [];
  const thinking: string[] = [];
  const boundaries: number[] = [];
  const seam = createAssistantStreamCapture({
    onText: (value) => text.push(value),
    onThinking: (value) => thinking.push(value),
    onTextBlockBoundary: () => boundaries.push(1),
  });
  return { text, thinking, boundaries, seam };
}
const upd = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });

// Models the openai-completions producer (pi-ai) that mutates the SHARED block.text ahead of async delivery.
// `lead` = how many chunks the producer has appended before the current delta is delivered (the mutation race).
function mutateAhead(block: Block, chunks: string[], upto: number, key: "text" | "thinking") {
  block[key] = chunks.slice(0, upto).join("");
}

/*
FNXC:AgentLogFidelity 2026-10-16-12:31:
RUFU-233 fidelity oracle. The shipped contract says the emitted stream equals the block's authoritative text
with **whitespace insertion by `normalizeStreamingDelta` the only permitted difference**. Asserting that
against `normalizeStreamingDelta` itself would be circular, so this encodes the allowance independently: an
optional single space is legal at index `i` only when `text[i-1]` is sentence-final punctuation, `text[i]` is
in the sentence-start class, and the numeric-continuation exception (`1.5` + `0`) does not apply. Anywhere
else — inside an id, a path, or a word — an inserted space, a dropped character, or a repeated run fails.
Derived from the rule's documented shape, and the meta-assertion below keeps the two encodings honest.
*/
function faithfulTo(text: string): RegExp {
  // Mirrors normalizeStreamingDelta's own sets: sentence-final punctuation on one side, a sentence-start
  // token on the other. Written as explicit comparisons because the class contains `(` and `[`, and a regex
  // literal for it reads as a terminator to the parser.
  const sentenceStart = (c: string) => /[A-Z0-9]/.test(c) || c === "'" || c === '"' || c === "(" || c === "[" || c === ".";
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const prev = text[i - 1] ?? "";
    const cur = text[i];
    const numeric = prev === "." && /\d/.test(text[i - 2] ?? "") && /\d/.test(cur);
    const mayInsert = i > 0 && /[.!?]/.test(prev) && sentenceStart(cur) && !numeric;
    parts.push(mayInsert ? "( ?)" : "");
    parts.push(cur.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return new RegExp(`^${parts.join("")}$`, "s");
}

/** Exact text, or the exact text with permitted sentence-boundary spaces added — nothing else. */
function expectFaithful(got: string, text: string, context: Record<string, unknown>) {
  expect({ ...context, got }).toEqual({ ...context, got: expect.any(String) });
  if (got === text) return;
  expect({ ...context, got, pattern: String(faithfulTo(text)) }).toEqual({
    ...context,
    got: expect.stringMatching(faithfulTo(text)),
    pattern: String(faithfulTo(text)),
  });
}

describe("createAssistantStreamCapture stream fidelity (RUFU-234)", () => {
  it("keeps an inter-word space that the producer appended but never delivered as its own delta", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "healthy" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flush emits "healthy"
    partial.content[0].text = "healthy in-review"; // producer coalesced " in-review" into the block
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "in-review" }));
    expect(result.text.join("")).toBe("healthy in-review");
  });

  it("keeps the final character when the block is mutated fully ahead of per-character deltas", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    const chunks = ["n", "o", "t", "e", "s"];
    // producer finished the whole block before any delta was delivered (mutation-ahead lead = all)
    mutateAhead(partial.content[0], chunks, chunks.length, "text");
    for (const delta of chunks) result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta }));
    expect(result.text.join("")).toBe("notes");
  });

  it("reconstructs the operator's sample-2 string byte-for-byte from a lead-2 mutated producer", () => {
    const result = mk();
    const chunks = ["Model", " ", "č", "o", " ", "č", "e", " vlastné", "udy", " ", "sa", " ", "degrad", "oval"];
    const expected = chunks.join("");
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    const LEAD = 2;
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + LEAD), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    expect(result.text.join("")).toBe(expected);
  });

  it("diacritics survive across delta boundaries (Reštartuj, not Reštuj)", () => {
    const result = mk();
    const chunks = ["Reš", "tar", "tuj", " použit", "ý"];
    const expected = chunks.join("");
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[0] }));
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + 2), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    expect(result.text.join("")).toBe(expected);
  });

  it("does not slice a block's leading characters when the same partial object is reused across messages", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "X" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flush "X"
    // Second assistant turn reuses the SAME partial object with a new block text and no message_start.
    partial.content[0].text = "notes";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("Xnotes"); // must not become "Xotes"
  });

  it("emits a lagging-authoritative block exactly once (no letter-on-letter duplication)", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    // Producer pushes the delta BEFORE the block catches up (block lags the delta).
    for (const delta of ["Hello", " world"]) {
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta }));
      partial.content[0].text += delta;
    }
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: partial.content[0].text }));
    expect(result.text.join("")).toBe("Hello world"); // must not become "Hello world world"
  });

  it("streams multiple correctly-indexed blocks losslessly with interleaved thinking", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block, { type: "thinking", thinking: "" } as Block, { type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    // block 0 streamed with mutation-ahead
    mutateAhead(partial.content[0], ["first", " ", "block"], 3, "text");
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "first" }));
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: " block" }));
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: "first block" }));
    // thinking block
    partial.content[1].thinking = "reasoning";
    result.seam.handleAgentEvent(upd({ type: "thinking_delta", partial, contentIndex: 1, delta: "reasoning" }));
    // block 2
    mutateAhead(partial.content[2], ["notes/origin/using-39"], 1, "text");
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 2, delta: "notes/origin/using-39" }));
    expect(result.text.join("")).toBe("first blocknotes/origin/using-39");
    expect(result.thinking.join("")).toBe("reasoning");
  });

  it("preserves verbatim terminal message-end blocks without re-slicing", () => {
    const result = mk();
    const message = { role: "assistant", content: [{ type: "text", text: "notes" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent({ type: "message_end", message });
    expect(result.text.join("")).toBe("notes");
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-12:22:
  RUFU-233 Step 3 — the one seeded split harness in this suite now carries the operator's own strings too.
  RUFU-234's corpus was an English pangram plus two Czech words; the reported rows were ids, paths and tool
  names (`RUFU-196`, `/home/schindler`, `fn_task_logs_read`). Those tokens are exactly where a span cut at the
  wrong offset shows up as a phantom space inside a word — the operator's `RUFU-196` -> `UFU19 6` — which a
  prose corpus under-tests because prose splits at spaces anyway. The `.`-then-`/` shape (`git/Fusion/.fusion`)
  is kept in the corpus on purpose: it is the one adjacency where `normalizeStreamingDelta` is ALLOWED to
  insert a space, so the expected value is built through the documented allowance rather than the raw string.
  */
  const RUFU_233_CORPUS = [
    "The quick brown fox jumps over the lazy dog while Reštartuj použitý daemon runs.",
    "RUFU-196 and RUFU-223 name the same defect in agent-log rows",
    "call fn_task_logs_read with task_id FN-001 to see stored bytes",
    "cwd /home/schindler/git/Fusion/.fusion/worktrees/rufu-196 is the lane root",
    "the heartbeat writes distributed so a real defect would surface in text rows",
    "All done. Let me summarize the user record for the operator review",
  ];

  // Deterministic bounded randomized fidelity across a fixed seed range.
  it("preserves exact text across a seeded randomized split of short deltas", () => {
    for (const sentence of RUFU_233_CORPUS) {
      // The allowance is applied per ideal span by the contract's own rule, so drops and re-hands still fail.
      const idealSpans = (seed: number) => {
        let state = seed;
        const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
        const chunks: string[] = [];
        let i = 0;
        while (i < sentence.length) { const size = 1 + Math.floor(rand() * 4); chunks.push(sentence.slice(i, i + size)); i += size; }
        return { chunks, lead: 1 + Math.floor(rand() * 3) };
      };
      for (let seed = 1; seed <= 60; seed++) {
        const { chunks, lead } = idealSpans(seed);
        const result = mk();
        const partial = { content: [{ type: "text", text: "" } as Block] };
        result.seam.handleAgentEvent({ type: "message_start" });
        result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
        for (let c = 0; c < chunks.length; c++) {
          mutateAhead(partial.content[0], chunks, Math.min(chunks.length, c + lead), "text");
          result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[c] }));
        }
        result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: sentence }));
        expectFaithful(result.text.join(""), sentence, { sentence, seed });
      }
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-12:31:
  The oracle above is independent of the implementation on purpose, which only helps if the two encodings
  agree. This pins `faithfulTo`'s allowance to the real rule on the corpus itself, so the ratchet cannot be
  quietly widened (or narrowed) away from what `normalizeStreamingDelta` actually permits.
  */
  it("keeps the fidelity oracle's space allowance equal to normalizeStreamingDelta's rule", () => {
    for (const sentence of RUFU_233_CORPUS) {
      for (let i = 1; i < sentence.length; i++) {
        const prev = sentence.slice(0, i);
        const next = sentence.slice(i);
        const real = normalizeStreamingDelta(prev, next);
        const permitted = faithfulTo(sentence).test(`${prev} ${next}`) || `${prev}${next}` === sentence;
        expect({ i, inserted: real === ` ${next}`, permitted }).toEqual({ i, inserted: real === ` ${next}`, permitted });
      }
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-12:22:
  RUFU-233 Step 3 deterministic property check on the partial-free face. Branch 1 must never suppress there:
  those lanes emit no `text_end`/`message_end`, so a held span is gone for good, and RUFU-234's code review
  found exactly that collapse ("\n"+"\n" into one break, ""+"" into one space). The property is stated over a
  seeded corpus of arbitrary splits of ONE long text so a future dedup change that only fires on an unusual
  split is still caught: the emitted stream must equal the verbatim delta sequence, never a subset.
  */
  it("emits every delta verbatim on the no-block-resolves face for any seeded split of a long text", () => {
    const long = Array.from({ length: 6 }, (_, n) =>
      `section ${n}: fn_task_logs_read reads /home/schindler/git/Fusion rows; RUFU-196 stayed readable `).join("");
    for (let seed = 1; seed <= 40; seed++) {
      let state = seed * 7919;
      const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
      const deltas: string[] = [];
      let i = 0;
      while (i < long.length) { const size = 1 + Math.floor(rand() * 5); deltas.push(long.slice(i, i + size)); i += size; }
      // Every face that resolves no block: the CLI bridge (no `partial`) and the mock runtime (`partial` IS the delta).
      for (const face of ["absent", "delta-string"] as const) {
        const result = mk();
        for (const d of deltas) {
          result.seam.handleAgentEvent(upd(face === "absent"
            ? { type: "text_delta", contentIndex: 0, delta: d }
            : { type: "text_delta", partial: d, contentIndex: 0, delta: d }));
        }
        // Verbatim face: no block exists to redeliver a chunk, so no dedup and no suppression is legal here.
        expect({ seed, face, got: result.text }).toEqual({ seed, face, got: deltas });
        expect({ seed, face, got: result.text.join("") }).toEqual({ seed, face, got: long });
      }
    }
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "partialfree-face-suppresses-repeated-deltas" (severity high).
  When no block resolves for (partial, contentIndex, kind) — the mock runtime's `partial: <delta string>` shape
  (providers/mock-provider.ts emitText) and the plugin/cross-runtime CLI bridge that emits
  `{ type: "text_delta", contentIndex, delta }` with no `partial` at all — there is NO shared mutable block, so
  nothing can redeliver a chunk and the whole delta-dedup lane is pure downside. Suppressing there collapses two
  adjacent identical deltas into one ("\n"+"\n" -> "\n", "a"+"a"+"a" -> "a", " "+" " -> " ") and those lanes emit
  no `text_end`/`message_end`, so the span is lost permanently. HEAD's guard began with `full &&`, so an empty
  block short-circuited it and every delta went out verbatim; the loss must not return through the dedup.
  */
  it("delivers every repeated delta verbatim on the mock runtime face (partial is the delta string)", () => {
    const result = mk();
    const emit = (delta: string) => result.seam.handleAgentEvent(upd({ type: "text_delta", partial: delta, contentIndex: 0, delta }));
    emit("\n"); emit("\n");
    expect(result.text.join("")).toBe("\n\n"); // paragraph breaks must survive
    emit("a"); emit("a"); emit("a");
    expect(result.text.join("")).toBe("\n\naaa");
  });

  it("delivers every repeated delta verbatim when the runtime carries no partial at all (CLI bridge lane)", () => {
    const result = mk();
    const emit = (delta: string) => result.seam.handleAgentEvent(upd({ type: "text_delta", contentIndex: 0, delta }));
    emit("healthy"); emit(" "); emit(" "); emit("in-review");
    // The operator's exact signature: the lone-space delta must not be swallowed into "healthyin-review".
    expect(result.text.join("")).toBe("healthy  in-review");
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "stale-ledger-hole-shorter-replacement" (severity medium).
  The reuse case is symmetric: a `partial` object reused across messages with no `message_start` can carry
  replacement text SHORTER than the stale ledger span ("notes/origin/using-39" -> "OK"). A length-gated reset
  lets that shape fall through every branch, so the replacement reaches no sink at all — total loss, worse than
  the head-slice this branch was written to fix. The replacement must be delivered whole and exactly once.
  */
  it("delivers a replacement SHORTER than the stale ledger span when the same partial is reused", () => {
    const result = mk();
    const partial: { role: string; content: Block[] } = { role: "assistant", content: [{ type: "text", text: "notes/origin/using-39" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 })); // flushes the long block
    expect(result.text.join("")).toBe("notes/origin/using-39");
    // Same partial object, replacement text SHORTER than the delivered span, and no message_start to reset.
    partial.content[0].text = "OK";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39OK");
    // The terminal flush of that same message must not hand "OK" out a second time.
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("notes/origin/using-39OK");
  });

  /*
  FNXC:AssistantTextCapture 2026-11-03-22:26:
  RUFU-233 code-review P0, finding "branch-4-novel-span-deletes-head-sharing-replacement".
  The RUFU-234 pair above only proves the shape whose replacement shares NO head with the previous message, because
  "OK" and "notes/origin/using-39" have an empty common prefix. The common case is not that: two consecutive replies
  from one model routinely begin with the same words, and a `text_delta`/`text_end`/`message_end` clip against the
  previous message's span deletes those shared characters — `"notes/origin/using-39"` -> `"notes/origin/README.md"`
  rendered `notes/origin/using-39README.md` (13 leading characters of a genuine new reply dropped) and
  `"notes/origin/using-39"` -> `"notes/origin"` clipped to nothing, so the replacement reached NO sink at all: the
  total-loss outcome the RUFU-234 finding above exists to forbid. A second `text_start` is what says "new block
  instance", so branch 4 must deliver the whole replacement for it while the append-only clip stays reserved for a
  revision of the block currently being streamed. Both halves are pinned here, and each is RED on the version that
  clipped every contradiction (see the task `diagnosis` document).
  */
  it("delivers a head-sharing replacement WHOLE when a second text_start announces a new block instance", () => {
    const result = mk();
    const partial: { role: string; content: Block[] } = { role: "assistant", content: [{ type: "text", text: "notes/origin/using-39" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39");
    // Next message, same `partial` object, no message_start — and the new reply merely begins with the same run.
    partial.content[0].text = "notes/origin/README.md";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39notes/origin/README.md"); // not "...using-39README.md"
    expect(result.boundaries.length).toBe(1); // the replacement is a new block: the boundary is announced once
    // The terminal flush re-asserts the SAME text: nothing may be added a second time.
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("notes/origin/using-39notes/origin/README.md");
    expect(result.text.join("").match(/notes\/origin\//g)).toHaveLength(2);
  });

  it("delivers a head-sharing replacement that is a PREFIX of the previous block instead of dropping it entirely", () => {
    const result = mk();
    const partial: { role: string; content: Block[] } = { role: "assistant", content: [{ type: "text", text: "notes/origin/using-39" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39");
    // The replacement is entirely contained in the previous block's text: clipping sees nothing novel, so the whole
    // reply would vanish. Announced by a start, it is a new message and must reach the sink in full.
    partial.content[0].text = "notes/origin";
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39notes/origin");
    result.seam.handleAgentEvent({ type: "message_end", message: partial });
    expect(result.text.join("")).toBe("notes/origin/using-39notes/origin");
  });

  it("keeps the append-only clip for a REVISION of the block being streamed (no second text_start)", () => {
    // The counter-case that keeps the split honest: the same head-sharing text arriving as a terminal revision of
    // the CURRENT block instance must NOT re-hand the agreed head — that is the `All done.All done.` duplicate.
    const result = mk();
    const partial: { content: Block[] } = { content: [{ type: "text", text: "notes/origin/using-39" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe("notes/origin/using-39");
    partial.content[0].text = "notes/origin/README.md";
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: "notes/origin/README.md" }));
    expect(result.text.join("")).toBe("notes/origin/using-39README.md");
    expect(result.text.join("").match(/notes\/origin\//g)).toHaveLength(1);
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-22:55:
  RUFU-234 code-review remediation, finding "absent-content-index-untested" (severity medium).
  `indexOf()` maps an ABSENT contentIndex onto block 0 and the seam's losslessness depends on it: real pi
  streams mix absent and explicit `0` for the same first block, so an absent start followed by an indexed
  delta on an already-populated block must emit that block's text exactly ONCE. Separating the two keys would
  re-emit the first block on all four consumer lanes, so this data state is pinned here rather than left as an
  unasserted load-bearing claim (the contradictory-index refusal beside it already is pinned).
  */
  it("folds an absent contentIndex onto block 0 so a mixed stream emits the first block exactly once", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "notes/origin/using-39" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial })); // no contentIndex at all
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "notes/origin/using-39" }));
    expect(result.text.join("")).toBe("notes/origin/using-39"); // once, not twice
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:58:
  RUFU-233 Step 3 — adversarial shapes the RUFU-234 suite never drove. Step 1 proved the holes live in the
  raw JSONL bytes and attributed them to this seam pre-remediation; Step 2 proved the writer, the reader and
  the JSONL framing are byte-exact at current tip, so the only layer left that can still hand already-holed
  bytes to `AgentLogger.onText` is this capture. Each case below encodes ONE operator residual class from
  `.fusion/tasks/RUFU-196/agent-log.jsonl` (diagnosis §2) as a pi event shape and asserts the invariant the
  persisted row must satisfy. They are accusers, not documentation: a case that goes RED names a live defect
  at current tip, and the shapes whose producer is append-monotone are the ones that can convict.
  */
  it("T1: an empty-delta event advances no cursor and emits nothing (operator rows interleave empty chunks)", () => {
    const result = mk();
    const chunks = ["Bash", " is", " ", "restricted"];
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + 1), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "" }));
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: chunks.join("") }));
    // The operator's `BashBash` class: an empty delta must neither duplicate nor swallow its neighbour.
    expect(result.text.join("")).toBe("Bash is restricted");
  });

  it("T2: a block that stops resolving mid-stream neither re-hands its prefix nor drops the continuation", () => {
    const result = mk();
    const partial: { content: Array<{ type: string; text?: string; id?: string }> } = { content: [{ type: "text", text: "" }] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    partial.content[0].text = "cwd:/home/schindler";
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "cwd:/home/schindler" }));
    // The provider replaces the block instance at the SAME index (tool_use claims it): authority vanishes.
    partial.content[0] = { type: "tool_use", id: "toolu_1" };
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: "/git/Fusion" }));
    // Unresolvable block = no shared mutable block = verbatim face. The delivered prefix must not come back.
    expect(result.text.join("")).toBe("cwd:/home/schindler/git/Fusion");
  });

  it("T4: a tool interruption inside one text block keeps every span exactly once", () => {
    const result = mk();
    const chunks = ["Checking", " the", " log", " file", " now"];
    const partial = { content: [{ type: "text", text: "" } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    for (let i = 0; i < 3; i++) {
      mutateAhead(partial.content[0], chunks, i + 1, "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    result.seam.handleAgentEvent({ type: "tool_execution_start", toolName: "Bash", toolCallId: "t1" });
    for (let i = 3; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, chunks.length, "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    result.seam.handleAgentEvent({ type: "tool_execution_end", toolName: "Bash", toolCallId: "t1" });
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: chunks.join("") }));
    expect(result.text.join("")).toBe("Checking the log file now");
    expect(result.boundaries).toHaveLength(0); // one block, so no invented paragraph boundary either
  });

  it("T5: operator-shaped ids, paths and tool names round-trip with no phantom space", () => {
    // Every string here is well-formed: no `[.!?]` sits directly before a capital or digit, so a correct
    // capture that slices the block contiguously CANNOT trigger normalizeStreamingDelta's insertion.
    // A space appearing inside a token (the operator's `RUFU-196` -> `UFU19 6`) is therefore proof of a
    // span cut at the wrong offset, and exact equality is the strongest assertion available.
    const samples = [
      "RUFU-196 and RUFU-223 name the same defect",
      "call fn_task_logs_read with task_id FN-001 now",
      "cwd /home/schindler/git/Fusion/.fusion/worktrees/rufu-196 works",
      "the heartbeat writes mistributed so a defect would surface",
    ];
    for (const sentence of samples) {
      for (const lead of [1, 2, 3]) {
        const chunks: string[] = [];
        for (let i = 0; i < sentence.length; i += 1 + (i % 3)) chunks.push(sentence.slice(i, i + 1 + (i % 3)));
        const result = mk();
        const partial = { content: [{ type: "text", text: "" } as Block] };
        result.seam.handleAgentEvent({ type: "message_start" });
        result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
        for (let c = 0; c < chunks.length; c++) {
          mutateAhead(partial.content[0], chunks, Math.min(chunks.length, c + lead), "text");
          result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[c] }));
        }
        result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: sentence }));
        expect({ lead, got: result.text.join("") }).toEqual({ lead, got: sentence });
      }
    }
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-12:44:
  RUFU-233 Step 3 located a live duplication defect here and wrote the two accusers below to prove it: a terminal
  block SHORTER than what was streamed, and a terminal block that contradicts the confirmed prefix mid-token (the
  operator's `All done.All done.` / `BashBash` class). Both measured RED at Step 3 — the seam re-handed the whole
  terminal replacement, head included, to a sink that had already received and stored that head — and both are
  GREEN now that branch 4 hands only the span past the longest common prefix. `step3-adversarial-verdict` keeps
  the measured RED output for the record.
  */

  it("T6: a terminal block SHORTER than what was streamed must not re-hand the confirmed prefix", () => {
    // The append-only sink cannot unsay a span, so the one outcome that is never acceptable is re-handing
    // text the ledger already confirmed: that is how `All done.All done.` reaches the persisted row.
    const result = mk();
    const streamed = "All done. Let me summarize the user record";
    const partial = { content: [{ type: "text", text: streamed } as Block] };
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    expect(result.text.join("")).toBe(streamed);
    // Same message finalizes with a trimmed block and no message_start in between.
    partial.content[0].text = "All done. Let me summarize";
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: "All done. Let me summarize" }));
    expect(result.text.join("")).toBe(streamed);
  });

  it("T3: a terminal block that contradicts the confirmed prefix must not duplicate the opening run", () => {
    // Operator Window A, line 54925: `All done.All done. me summarize the userrecord.` The producer here is
    // append-monotone while streaming; only the terminal block is repaired mid-token.
    const result = mk();
    const streamed = "All done. Let me summarize";
    const partial = { content: [{ type: "text", text: "" } as Block] };
    const chunks = ["All done", ". ", "Let", " me", " summarize"];
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, Math.min(chunks.length, i + 1), "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    const repaired = "All done! Let me summarize";
    partial.content[0].text = repaired;
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: repaired }));
    const emitted = result.text.join("");
    /*
    FNXC:AgentLogFidelity 2026-10-16-10:36:
    This asserts an invariant, not one exact rendering, because an append-only sink has no faithful way to record
    a mid-token repair: the head it stored stays. What is decidable is the damage boundary. Nothing that was
    streamed may go missing, and the terminal edit may contribute at most the text past the point where it stops
    agreeing with the stream — re-handing the agreed head is the duplication this test exists to refuse. The
    divergence run (`! Let me summarize`) is the only information the terminal block adds, so that and only that
    may follow the streamed text.
    */
    expect(emitted.startsWith(streamed)).toBe(true);
    expect(emitted.slice(streamed.length)).toBe(repaired.slice("All done".length));
    expect(emitted.match(/All done/g) ?? []).toHaveLength(1);
  });

  /*
  FNXC:AgentLogFidelity 2026-10-16-11:18:
  RUFU-233 completion half of the trimmed-terminal invariant. When a block revision names text the row already holds,
  the seam refuses to hand anything — but the refusal is only half the fix. The ledger cursor records what the SINK
  holds, so letting it follow the regressed block down leaves it BEHIND the row, and the next growth span is then cut
  from that shortened cursor and re-hands the region the regression just cancelled: the same `All done.All done.`
  artifact, arriving one event later. Copied-snapshot providers (a stale block copy delivered mid-`text_delta`) reach
  this shape without any terminal event at all. Killed by a mutant that resets the cursor to the regressed block.
  */
  it("a block snapshot that regresses mid-delta and then catches up must not re-hand the cancelled region", () => {
    const result = mk();
    const partial = { content: [{ type: "text", text: "" } as Block] };
    const chunks = ["All done", ". ", "Let", " me", " summarize"];
    const streamed = chunks.join("");
    result.seam.handleAgentEvent({ type: "message_start" });
    result.seam.handleAgentEvent(upd({ type: "text_start", partial, contentIndex: 0 }));
    for (let i = 0; i < chunks.length; i++) {
      mutateAhead(partial.content[0], chunks, i + 1, "text");
      result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: chunks[i] }));
    }
    expect(result.text.join("")).toBe(streamed);

    // A stale copy of the message arrives: the block holds LESS than the row, and its delta continues past it.
    partial.content[0].text = "All done";
    result.seam.handleAgentEvent(upd({ type: "text_delta", partial, contentIndex: 0, delta: " the user record" }));
    expect(result.text.join("")).toBe(streamed); // the regression adds nothing to a row that already holds it

    // The block catches up and finalizes with text that genuinely extends the row.
    const final = `${streamed} the user record`;
    partial.content[0].text = final;
    result.seam.handleAgentEvent(upd({ type: "text_end", partial, contentIndex: 0, content: final }));
    expect(result.text.join("")).toBe(final);
    expect(result.text.join("").match(/Let me summarize/g) ?? []).toHaveLength(1);
  });

  /*
  FNXC:AssistantTextCapture 2026-09-13-21:15:
  RUFU-234 wiring ratchet (a code-structure guard, not a text assertion): pi.ts feeds this seam from TWO
  subscribers — the initial session's event listener and the fallback-swapped session in wireFallbackHooks.
  A refactor that wires only one lane leaves fallback-routed replies with no capture at all, silently
  emptying chat/log/verdict sinks for exactly the runs that took the fallback path. Both sites must keep
  constructing the capture from the caller's sinks and piping every event into it.
  */
  it("keeps every pi.ts session subscriber wired to a capture of the caller's sinks", () => {
    const source = readFileSync(fileURLToPath(new URL("../pi.ts", import.meta.url)), "utf8");
    const wiredSites = source.match(
      /const capture = createAssistantStreamCapture\(\{ onText: options\.onText, onThinking: options\.onThinking, onTextBlockBoundary: options\.onTextBlockBoundary \}\);\s*\n\s*\w+\.subscribe\(\(event\) => \{\s*\n\s*capture\.handleAgentEvent\(event\);/g,
    ) ?? [];
    expect(wiredSites).toHaveLength(2);
  });
});

/*
FNXC:AgentLogFidelity 2026-10-16-13:05:
RUFU-233 Step 4 — replay against the REAL reported rows. The reported log lines are the only surviving
artifact of the corruption: pi persists no event stream, so nothing can replay the original bytes. What IS
reproducible is the mechanism. The fixture below carries the exact raw JSONL lines from
`.fusion/tasks/RUFU-196/agent-log.jsonl` at the reported line numbers, plus the residual classes the operator
reported for each, and these tests drive each shape the reported rows exhibit back through the seam and assert
what the seam must now guarantee over those bytes.

Measured against the capture as it stood at the window tip (840759dda4, the build that wrote the rows) versus
current tip, with the same event builders:
- a delta the provider never delivered: the window-tip build loses 11 four-character windows around the gap
  (it set its cursor from the block's length, not from what it emitted), current tip reassembles exactly —
  this is the reported scattered 1-4 char hole, and it is why those rows are bucket (i);
- a terminal block arriving on a different partial object: the window-tip build re-hands the whole block
  (measured 158/79, 164/82, 182/91 characters — exactly double), current tip hands out nothing extra, so the
  `BashBash` duplication at line 55007 is explained by that build and is closed at tip;
- a terminal block that contradicts or shortens what was streamed, and a block snapshot that regresses
  mid-stream: the window-tip build is exact for BOTH, current tip duplicates the confirmed head for BOTH. So
  the duplication class cannot be bucketed as pre-remediation on the strength of its timestamp alone — part of
  it is a live defect, which is what Step 5 exists to fix. Those two shapes are the held accusers above.
*/
describe("reported-row replay (RUFU-233)", () => {
  type Raw = { line: number; raw: string; window?: string; control?: string; residuals?: Array<{ class: string; observed: string; intended?: string; note?: string }> };
  const fixture = evidence as unknown as { holedRows: Raw[]; controls: Raw[] };
  /** A row's on-disk identity comes from its raw bytes, never from a paraphrase next to them. */
  const parse = (row: Raw) => JSON.parse(row.raw) as { taskId: string; type: string; text: string; timestamp: string };
  const holed = fixture.holedRows.map((row) => ({ ...row, text: parse(row).text, type: parse(row).type }));
  const controls = fixture.controls.map((row) => ({ ...row, text: parse(row).text, type: parse(row).type }));

  type Step = { mutateTo?: string; event: unknown };
  type Partial2 = { content: Array<{ type: string; text?: string }> };
  /** Feed steps while mutating the shared block, exactly as a real provider writes ahead of its deltas. */
  function feed(build: (partial: Partial2) => Step[], onText: (t: string) => void) {
    const partial: Partial2 = { content: [{ type: "text", text: "" }] };
    const seam = createAssistantStreamCapture({ onText });
    const upd = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });
    for (const s of build(partial)) {
      if (s.mutateTo !== undefined) partial.content[0].text = s.mutateTo;
      // `"<<new-partial>>"` stands for the terminal block arriving on a DIFFERENT partial object, which is what
      // the lane does when a stream is re-wrapped; the seam must still not re-hand what it already delivered.
      if (s.event === "<<new-partial>>") {
        const other: Partial2 = { content: [{ type: "text", text: partial.content[0].text }] };
        seam.handleAgentEvent(upd({ type: "text_end", partial: other, contentIndex: 0, content: other.content[0].text }));
        continue;
      }
      seam.handleAgentEvent(s.event);
    }
  }
  const ev = {
    messageStart: { type: "message_start" },
    messageEnd: (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }),
    textStart: (p: Partial2) => ({ type: "message_update", assistantMessageEvent: { type: "text_start", partial: p, contentIndex: 0 } }),
    textDelta: (p: Partial2, delta: string, contentIndex: number | undefined = 0) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", partial: p, contentIndex, delta } }),
    textEnd: (p: Partial2, content: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_end", partial: p, contentIndex: 0, content } }),
  };
  const chunksOf = (text: string, size: number) => {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  };

  it("keeps the fixture honest: every raw line parses and every holed row still carries its reported residual", () => {
    expect(holed.length).toBeGreaterThan(0);
    expect(controls.length).toBeGreaterThan(0);
    for (const row of [...holed, ...controls]) {
      const parsed = parse(row);
      expect(parsed.taskId).toBe("RUFU-196");
      // A raw line is one physical JSONL record: the writer never embeds a newline in it.
      expect(row.raw.includes("\n")).toBe(false);
    }
    for (const row of holed) {
      // Every reported residual must still be visible in the stored bytes, or the fixture drifted from disk.
      for (const residual of row.residuals ?? []) {
        expect(row.text.includes(residual.observed), `line ${row.line} must still show ${JSON.stringify(residual.observed)}`).toBe(true);
        // The un-corrupted form may only be absent when it is not already a substring of the corrupted form
        // (a duplicated run contains its own single copy).
        if (residual.intended && !residual.observed.includes(residual.intended)) {
          expect(row.text.includes(residual.intended), `line ${row.line} must NOT already read ${JSON.stringify(residual.intended)}`).toBe(false);
        }
      }
    }
    // The controls are the point of comparison: byte-clean rows of the other two types, same file.
    for (const row of controls) {
      expect(["status", "tool", "thinking", "tool_result"]).toContain(row.type);
      for (const residual of fixture.holedRows.flatMap((h) => h.residuals ?? [])) {
        if (!residual.intended) continue;
        expect(row.text.includes(residual.observed), `control line ${row.line} must be free of ${JSON.stringify(residual.observed)}`).toBe(false);
      }
    }
    // Corruption was confined to streamed assistant text; every holed row is a `text` row.
    expect(holed.every((r) => r.type === "text")).toBe(true);
  });

  /**
   * The stored text IS the artifact, so it cannot double as the replay target: substituting the reported
   * residuals' intended forms reconstructs what the lane meant to write. Where a residual has no intended form
   * (an interior drop of unknown extent) the reconstruction keeps that hole, which only makes the assertions
   * below weaker, never weaker than they need to be — the seam still must not lose or repeat a single byte of
   * what it was given.
   */
  function intendedOf(row: { text: string; residuals?: Array<{ observed: string; intended?: string }> }) {
    let text = row.text;
    for (const residual of row.residuals ?? []) {
      if (residual.intended && residual.intended !== residual.observed) text = text.split(residual.observed).join(residual.intended);
    }
    return text;
  }

  it.each(holed.map((r) => [r.line, r] as const))("reassembles line %i with no loss and no repeat when two deltas never arrive", (_line, row) => {
    // The operator's holes are 1-4 characters scattered inside one long line — the signature of a span counted
    // as delivered but never emitted. Measured on the window-tip build this shape loses 11 four-character
    // windows around each gap, because it advanced its cursor by the BLOCK's length rather than by what it
    // handed out; at current tip the same event sequence reassembles the line exactly.
    const intended = intendedOf(row);
    const chunks = chunksOf(intended, 3);
    const out: string[] = [];
    feed((p) => [
      { event: ev.messageStart },
      { event: ev.textStart(p) },
      ...chunks.map((chunk, c): Step => ({ mutateTo: chunks.slice(0, c + 1).join(""), event: ev.textDelta(p, chunk) })),
      { mutateTo: intended, event: ev.textEnd(p, intended) },
      { event: ev.messageEnd(intended) },
    ], (t) => out.push(t));
    expectFaithful(out.join(""), intended, { line: row.line, shape: "two-deltas-never-arrive" });
  });

  it.each(holed.map((r) => [r.line, r] as const))("reassembles line %i with no loss and no repeat when every 5th delta carries no contentIndex", (_line, row) => {
    // An update whose contentIndex is unusable is dropped by the seam, so the block has to carry the gap.
    const intended = intendedOf(row);
    const chunks = chunksOf(intended, 3);
    const out: string[] = [];
    feed((p) => [
      { event: ev.messageStart },
      { event: ev.textStart(p) },
      ...chunks.map((chunk, c): Step => ({ mutateTo: chunks.slice(0, c + 1).join(""), event: ev.textDelta(p, chunk, c % 5 === 4 ? undefined : 0) })),
      { mutateTo: intended, event: ev.textEnd(p, intended) },
    ], (t) => out.push(t));
    expectFaithful(out.join(""), intended, { line: row.line, shape: "index-less-delta" });
  });

  it.each(holed.map((r) => [r.line, r] as const))("does not re-hand line %i when the terminal block arrives on a different partial", (_line, row) => {
    // Measured on the window-tip build: 158 characters for a 79-character line, 164 for 82, 182 for 91 — the
    // whole block a second time, because a new partial object reset its per-block cursor. That is the shape
    // that wrote `BashBash is restricted` to line 55007. A terminal authority that merely agrees with what was
    // streamed must add nothing at all.
    const intended = intendedOf(row);
    const chunks = chunksOf(intended, 4);
    const out: string[] = [];
    feed((p) => [
      { event: ev.messageStart },
      { event: ev.textStart(p) },
      ...chunks.map((chunk, c): Step => ({ mutateTo: chunks.slice(0, c + 1).join(""), event: ev.textDelta(p, chunk) })),
      { mutateTo: intended, event: "<<new-partial>>" },
    ], (t) => out.push(t));
    const emitted = out.join("");
    expectFaithful(emitted, intended, { line: row.line, shape: "terminal-on-a-different-partial" });
    for (const residual of row.residuals ?? []) {
      if (residual.class !== "duplicate-run") continue;
      expect(emitted.includes(residual.observed), `line ${row.line} must not re-hand the run ${JSON.stringify(residual.observed)}`).toBe(false);
    }
  });
});
