---
title: Stream capture trusted the delta against a stale block snapshot and deleted characters the provider actually sent
date: 2026-09-13
category: logic-errors
module: engine assistant-text-capture
problem_type: logic_error
component: engine
symptoms:
  - "Streamed assistant replies lose scattered 1-4 character runs and whole inter-word spaces (\"healthy in-review\" -> \"healthyin-review\", \"notes\" -> \"otes\") while the same text is intact in non-streamed surfaces"
  - "Corruption differs per run over the same text (non-deterministic, race-shaped); sometimes the same word appears twice (\"RešReštartuj\") instead of a loss"
  - "Chat bubbles, agent-log text rows, and reviewer verdict text can all show the loss while the provider's final message content is whole"
  - "A card's own agent-log narration about the bug may itself contain dropped spaces/characters (the defect corrupts the lane that would describe it)"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "packages/engine/src/execution/assistant-text-capture.ts"
  - "packages/engine/src/pi.ts"
  - "packages/engine/src/executor/execute-workflow-step.ts"
  - "packages/engine/src/execution/reviewer.ts"
  - "packages/dashboard/src/chat.ts"
  - "packages/dashboard/src/sse-buffer.ts"
  - "packages/engine/src/agents/agent-logger.ts"
  - "packages/engine/src/__tests__/agent-log-round-trip-fidelity.test.ts"
  - "packages/engine/src/__tests__/heartbeat-text-fidelity.test.ts"
  - "packages/engine/src/__tests__/triage-text-fidelity.test.ts"
tags:
  - streaming
  - pi-event-shape
  - capture-seam
  - chat
  - agent-log
  - openai-completions
  - RUFU-234
  - RUFU-233
---

# Stream capture trusted the delta against a stale block snapshot and deleted characters the provider actually sent

## What an operator saw

Streamed assistant replies — chat bubbles, task agent-log narration, reviewer verdict text — lost
scattered characters: single spaces between words (`healthy in-review` -> `healthyin-review`), 1-4
character runs (`notes` -> `otes`, `Reštartuj` -> `Reštuj`), and trailing text. The same messages
requested again came out differently; the provider's finalized message content (visible in provider-side
logs) had always contained the missing characters.

## Root cause

`createAssistantStreamCapture` (packages/engine/src/execution/assistant-text-capture.ts) was the single
capture seam every pi event passes through before reaching the chat SSE fan-out, the executor's
`output += delta` / agent-log fan-out, and the reviewer's verdict-text accumulator. Its pre-fix shape kept a
per-block `emitted` **offset count** and treated the block snapshot riding on the event (`event.partial`) as
if it were a stable prefix. The `text_delta` lane read:

```
if (full && full.endsWith(delta) && (emitted[kind].get(index) ?? 0) >= full.length) return;   // skip guard
emit(normalize(delta));                                                                        // hand out the DELTA
emitted[kind].set(index, full ? full.length : prior + delta.length);                           // pin to block length
```

while `flush()` (used by `text_start`, `text_end`, and the `message_end` terminal sweep) emitted
`text.slice(prior)` with that same ledger. With the `openai-completions` API, `partial` is the producer's
mutable working message object: by the time the async listener receives an older delta, the block has
typically been mutated **ahead** of it. Three independent deletion mechanisms and one duplication face
follow from that, each reproduced byte-for-byte in
`packages/engine/src/__tests__/assistant-text-capture-fidelity.test.ts`:

- **(a) The delta lane hands out `update.delta`, but the block is the authoritative text.** The producer
  coalesced `" in-review"` into the block while its delta payload carried only `"in-review"`, so the space
  exists in the authoritative text and in *no delta payload at all* — nothing ever emits it. The emitted text
  is whatever the deltas happened to carry, not what the block says. Signature:
  `healthyin-review` (RED: `expected 'healthyin-review' to be 'healthy in-review'`).
- **(b) The skip guard asks the wrong question, and the delta lane corrupts the only number that made it
  safe.** `full.endsWith(delta)` answers "does the block end with these characters?" — the *normal* state of
  the delta that ends the block — not "was this delta already delivered?". The ledger it leans on is pinned to
  the **whole block length** by the lane itself after emitting a single delta, so once the producer is caught
  up, `emitted >= full.length` holds at every following delta and any delta coinciding with the block tip is
  silently `return`ed. Short 1-4 character deltas and lone-space deltas coincide most often, which is why the
  loss reads as **scattered** rather than as truncation. Signatures: `note` for `notes`, and the whole trailing
  run lost between `degrad` and `oval` in the operator's sample 2.
- **(c) The ledger is keyed by index alone, so `flush()` slices with a stale `prior`.** `reset()` fires only on
  `message_start`, on `partial` object-identity change, and after `message_end`; when the same `partial` object
  is reused for a new block or message, `text.slice(prior)` cuts the replacement's head with the *previous*
  block's offset. Signature: `otes` for `notes` (RED: `expected 'Xotes' to be 'Xnotes'`).
- **(d) The mirror face — duplication.** Where the block *lags* the delta, the delta is emitted raw and the
  terminal flush then emits the same span again (`Hello world world`, `RešReštartuj`). This is why neither a
  dedupe-only nor a clamp-only repair was acceptable: the design could violate either invariant depending on
  producer timing, so loss and exactly-once had to be proven together.

Note also that the guard's leading `full &&` was the *only* thing protecting the partialFree face (mock
runtimes, CLI bridges) from suppression — it short-circuited whenever no block resolved. That accident is
why the remediation post-mortem below had to restore the verbatim contract deliberately.

Why every innocent layer was falsified instead:

- **Persistence join (dashboard `chat.ts`, `finalResponseText` at line 4012)**: a test shows that whenever the transcript slice
  is longer, the join keeps the longer — so the join cannot delete; it merely masks a lossy
  accumulator. When no slice exists the join copies the accumulator verbatim, so any corruption seen
  in the persisted row provably came from the capture lane (4 RED-to-green assertions in
  `packages/dashboard/src/__tests__/chat-manager-stream-fidelity.test.ts`).
- **Overlay buffer (`sse-buffer.ts`)**: ring eviction is contiguous whole-frame only; a unit suite pins
  that no partial-frame or mid-string byte is dropped (`chat-stream-buffer-fidelity.test.ts`).
- **Compaction**: joins whole entries with explicit separators — entry-granular by code shape, so a
  mid-word deletion is unproducible at that layer.
- **Provider/upstream**: can only explain *additions* (a stray special-token marker,
  duplicated sentence runs, CJK fragments); the *deletions* were proven Fusion-side because the
  seam-level replay (no network involved) reproduced the exact operator signatures byte-for-byte.

## The fix

The ledger per `(kind, blockIndex)` no longer reconstructs text by slicing the delta against an event
snapshot. It tracks the raw delivered span and the provisional per-(kind, block) text, and emits from
the **authoritative** source in priority order:

1. **No block resolves** for `(partial, index, kind)` — the partialFree face (a mock runtime that passes the
   delta itself as `partial`, a plugin/cross-runtime CLI bridge that omits `partial`) -> deliver the raw delta
   verbatim, with the dedup lane skipped entirely. This branch is not a convenience: it is the branch that
   makes the *other* branches legal, because they all reason about a shared mutable block that does not exist
   here (see the post-mortem below).
2. Delta equals the provisional tail -> true whole-span redelivery, suppress.
3. Authoritative block (`event.partial.content[i].text`, present on every pi text event) extends the
   delivered span -> emit `authoritative.slice(delivered.length)`. Whitespace gaps between what was
   delivered and what the block now says are emitted, not skipped — this is what restored lost spaces.
4. Block text contradicts the span the *block itself* confirmed (block replaced mid-stream, e.g. the same
   `partial` reused across messages with no `message_start`) -> restart the ledger and emit the replacement
   whole, **regardless of whether it is longer or shorter** than the stale span.
5. No new authoritative text -> continue provisionally from the delta, deduped by containment
   (`endsWith` only for the provisional face; `includes` would silently swallow the legitimate
   `"Hel`+`"lo` continuation).

The old `delta.endsWith(blockText)` whole-span-suppression coincidence guard is gone, as is any
`startsWith`-prefix slice against a possibly-ahead snapshot. `normalizeStreamingDelta`
(`packages/engine/src/execution/streaming-delta.ts`) is exonerated and unchanged — it only ever
*inserts* spaces between glued sentence runs, never deletes.

## Invariants the fix must keep together

- **Losslessness**: concatenation of everything handed to the text sink for one block equals the
  block's final authoritative text (whitespace insertion by `normalizeStreamingDelta` the only allowed
  difference). Both corruption faces are pinned: scattered/space loss AND duplication
  (`Hello world world`, `RešReštartuj`) — a "fix" that trades one for the other fails the suite.
- **Exactly-once** (the RUFU-230 contract): terminal-flush and per-block-boundary flush must not
  re-emit what deltas already delivered. `assistant-text-capture.test.ts` and
  `assistant-text-capture-fidelity.test.ts` jointly pin both properties; they are regression-paired on
  purpose.
- **Consumer fan-out**: every capture consumer is asserted, not just chat — executor lane
  (`executor-step-text-fidelity.test.ts` drives the real `executeWorkflowStep` and checks the step
  output string, the agent-log text rows, and per-delta `onAgentText` all get the same intact bytes),
  reviewer lane (`reviewer.test.ts` mutated-ahead replay asserting `result.review`), and a structural
  ratchet that both pi.ts subscribers (initial + fallback-swapped in `wireFallbackHooks`) keep piping
  every event into a capture of the caller's sinks.
- **Stated refusal**: a contradictory `contentIndex` (NaN/negative/non-integer) names no resolvable
  block; its delta is deliberately refused rather than guessed onto block 0. The decision is asserted
  explicitly in `assistant-text-capture.test.ts` so a future losslessness sweep must change it
  consciously. Its mirror — an *absent* index folding onto block 0 — is equally load-bearing (real pi
  streams mix absent and explicit `0` for one block) and is pinned by a mixed-index replay in
  `assistant-text-capture-fidelity.test.ts`, because separating the two keys would re-emit the whole
  first block on all four consumer lanes.

### Reachability limit of the folding (verified boundary, not a defect)

The absent-index folding is sound while absent means "first block", which is every producer this repo
ships: the cross-runtime CLI bridge and the mock provider set `contentIndex` explicitly, and pi folds
absent only for block 0. A probe replay of the out-of-premise shape — a SECOND text block arriving with
an absent `contentIndex` while the first block's ledger is occupied — shows the delta delivered once as a
provisional continuation on the folded key and again by the terminal sweep on the block's real index
(`first block` + `notes/...` + `\n\n` + `notes/...`). It duplicates rather than deletes, and no producer
emits the shape, so it is recorded as a verified reachability boundary of the folding decision rather
than repaired: "which block does an unindexed delta belong to" is unresolvable from event data alone, and
guessing by cross-block containment would re-open the adjacent-identical-block collapse the remediation
just closed. The real multi-block shape (explicit indices) is pinned end-to-end — persisted row, boundary
separator, and terminal sweep — in `packages/dashboard/src/__tests__/chat-manager-stream-fidelity.test.ts`.

### Reachability limit of the partial-free face (verified boundary, not a defect)

The partial-free branch delivers verbatim and grows the ledger's `delivered` span without touching
`provisional`, because on that face a span is confirmed the instant it is handed out — there is no terminal
event that could later validate or contradict it. The two ledger fields stay mutually consistent only while
one face owns a ledger key for that key's whole life. A runtime that mixed partial-free and block-backed
deltas on the *same* `(kind, index)` key would leave `provisional` stale, and two later decisions would then
read it wrongly: a redelivery of that stale tail would be suppressed as a repeat, and the confirmed prefix
used to detect a replaced block would be short by that span. No shipped producer does this — the partial-free
face is exactly the mock runtime (which passes the delta itself as `partial`) and the cross-runtime CLI
bridge (which omits `partial`), and neither ever follows with a block-backed delta on the same key.

This is recorded as a boundary rather than repaired because the two candidate repairs fight each other:
clearing `provisional` when entering the verbatim branch makes a merely-lagging block look *replaced*, so the
replacement branch would re-hand the whole text (a duplication), while leaving it lets a redelivered stale
tail be suppressed (a deletion). Picking between them requires knowing which face the producer is on, which
is exactly what event data cannot say on the mixed shape. Choosing a silent tie-break is how this seam
acquired its original character-loss bug, so the boundary is documented instead of guessed past.

### Post-mortem: the fix reintroduced the bug on the face that has no authority

The first version of this fix applied its dedup lane to *every* event, including ones where no content
block resolves. On that face the block text is permanently `""`, so the ledger can never validate a span,
and two adjacent identical deltas collapsed into one: `"\n"+"\n"` emitted one newline (paragraph breaks
vanished), `" "+" "` emitted one space — reproducing the exact inter-word-space loss the task exists to
eliminate, on the mock-runtime and plugin-CLI lanes the surface enumeration names. Those lanes also emit no
`text_end`/`message_end`, so a held span is never recovered: the loss is permanent. The superseded
`delta.endsWith(blockText)` guard had been accidentally safe there only because it began with `full &&`, so
an empty block short-circuited it. Separately, the replaced-block reset was gated on the replacement being
*longer*, and a shorter replacement matched no branch at all, so that whole message reached no sink —
total loss, worse than the head-slice the branch was written to repair.

The generalizable lesson: **a dedup rule that cross-checks against authoritative state must be unreachable
where no authoritative state exists.** "Nothing observed yet" is not evidence that a span was already
delivered, and a recovery net (`text_end`/`message_end`) that some producers never emit cannot be assumed by
a suppression rule. Both holes were found by review, not by the author's own suite — the fixtures for the
affected lanes had distinct deltas, so the collapse never appeared.

## Detection guidance (costly lessons from this investigation)

- **Do not trust your own narration as evidence about this class of bug.** The defect corrupts the
  agent-log/streaming lane an agent would use to describe it — a log line saying "the space between
  `healthy` and `in-review` disappeared" may itself have dropped characters. Prove from bytes: the
  provider's final message content vs what the sinks received, not from prose.
- **Do not use hyphen-dropped IDs as detector evidence.** `RUFU-234` rendering as `RUFU234` is exactly
  the space/hyphen class this bug produces randomly; only presence-vs-absence of whole runs or
  duplicated runs discriminates layers, and even then cross-check against source files, not rendered
  log text.
- **Race-shaped corruption that shifts per run over identical input is producer-mutation-shaped.**
  When a consumer reads a *mutable shared object* (`event.partial`) asynchronously, any slice
  arithmetic against it (`startsWith`/`endsWith` at async time) is a time bomb; derive from the
  authoritative text the event itself carries.

## Verification

- `packages/engine/src/__tests__/assistant-text-capture-fidelity.test.ts` — operator signatures as
  deterministic pi event-shape fixtures (8 were RED on the pre-fix seam), a seeded randomized split
  sweep, and the pi.ts wiring ratchet.
- `packages/dashboard/src/__tests__/chat-manager-stream-fidelity.test.ts` — persisted-row
  corruption provably originates in the capture lane; the join is falsified as the deleter; the
  inter-block `\n\n` separator (chat.ts's `onTextBlockBoundary`, the only writer of block-separator
  whitespace) is pinned for a multi-block turn so a boundary-predicate regression cannot glue blocks
  unnoticed.
- `packages/dashboard/src/__tests__/chat-stream-buffer-fidelity.test.ts` — overlay falsified
  (contiguous whole-frame eviction only).
- `packages/engine/src/__tests__/executor-step-text-fidelity.test.ts` — executor dual-sink fan-out
  intact (RED without the fix: `healthyin-review` in every sink).
- Reviewer-lane case in `packages/engine/src/__tests__/reviewer.test.ts`.
- PartialFree/repeat and replacement cases in `assistant-text-capture-fidelity.test.ts`: adjacent identical
  deltas through the mock `partial: <string>` shape and the no-`partial` CLI shape, a replacement shorter than
  the stale ledger span delivered exactly once, and the absent-vs-`0` mixed-index replay. Each was recorded RED
  against the pre-remediation seam (`'healthy in-review'` with a dropped space; `\n\n` -> `\n`; the shorter
  replacement never delivered) before the production edit.
- Sibling context: RUFU-233 independently attributed the same corruption to this seam by its own
  investigation; both fixes converge on deriving from the authoritative block text.

<!--
FNXC:AgentLogFidelity 2026-10-16-13:58:
RUFU-233 closed the residual duplicate-run branch of this seam (branch 4 handed a contradicting
authoritative block WHOLE to an append-only sink) and settled the persisted-log question this file could
only claim: the holes were proven to exist in the bytes on disk, so the capture seam — not the store, the
framer, the reader, or the operator read route — is the author of a holed `text` row.
-->

## Post-remediation verdict from the persisted bytes (RUFU-233, 2026-10-16)

RUFU-233 was filed against **persisted** `agent-log.jsonl` rows and was resolved from raw bytes rather
than from any lane's narration, per this file's own detection guidance. The disk-first method and the
exoneration of the read route are recorded separately in
[agent-log-read-route-is-append-free.md](agent-log-read-route-is-append-free.md); the conclusions that
belong to *this* seam are:

- **The layer is this seam, proven on disk.** In the reported 19.5 MB / 73 668-line evidence file, 1 057
  distinct `text` rows (1.74 %) carry token-internal drops, and **0 of 13 042** `tool` / `tool_result` /
  `tool_error` / `status` rows do — same file, same sessions, same writer, same read route. The `}{`
  row-boundary count is 0. No discrete-row path and no read/serialize surface can produce that split;
  the buffered streaming face can, which is the definition of this capture seam.
- **Bucketing is per deploy-clock, not per file.** Every holed row is bucket (i) — produced by a build
  without today's fix. The window tip that wrote the reported rows is `840759dda4` (2026-09-13); all of
  RUFU-234's commits (`e3dbcee152`, `9bca0ab281`, `8b1d215b11`) and the three later remediations
  (`250911cc78`, `6a4b3e16cd`, `8fadafc819`) post-date it, and the file froze at 2026-09-15T21:16:59Z.
  Bucket (iii) — rows written by a provably fixed deployed bundle — is **permanently unreachable from
  this evidence**, so the residual question "does today's code still produce the shape?" was answered by
  replay, not by waiting. Two remediation SHAs named in the original spec (`0941918a73`, `f23b15d610`)
  do not exist in this repository.
- **Which residual branch this card closed: branch 4's hand-off.** Replaying identical event builders
  against the window-tip capture and current tip separated the classes. The scattered 1–4 character holes
  and the `BashBash is restricted` whole-block re-hand were both bucket-(i) and are exact at current tip.
  The **duplicate-run** class was the opposite: the window-tip build is exact for the two shapes that
  duplicate today — a terminal authority that **shortens** the block (the operator's
  `All done.All done.`) and a block snapshot that **regresses** mid-`text_delta` — so half of the
  duplicate-run symptom was a live defect in this seam. Branch 4 delivered the contradicting authoritative
  block *whole* to a sink that had already received, and persisted, its head. It now hands
  `novelSpan(authoritative, delivered)`: the run past the point where the block's new claim stops agreeing
  with what the sink holds, and nothing when the revision trims back to an already-held prefix. **That clip
  was itself too wide and was narrowed the same day — see "The append-only floor is owed to a revision,
  not to a replacement" below.**

### New reachability boundary discovered: an append-only sink cannot un-say a span

The four earlier remediations assumed a sink that could be re-synchronised with the authoritative block.
For `agent-log.jsonl` that assumption is false: `AgentLogger.onText` concatenates into one row, so the
only durable form of a block revision is an **addition**. Three consequences are now pinned by tests and
must be treated as the seam's floor:

1. A revision that **diverges mid-text** costs the row exactly one divergence span. No byte-exact cursor
   exists past a divergence that has already been written, so the ledger records the *block's claim*, not
   the row's bytes — recording the row's bytes instead would make the terminal re-assertion of the same
   revised authority read as new text and duplicate the divergence a second time.
2. A revision that **trims** back to a prefix the sink already holds hands nothing, and the cursor must
   **not** follow the block down: it records what the sink holds, and a shortened cursor makes the next
   growth span re-hand the region the trim just cancelled. That mutant is pinned by a
   revision-then-catch-up case.
3. This boundary is face-specific and does **not** extend the partial-free limit above: on the
   partial-free face there is no authority to contradict, so branch 4 is unreachable there and verbatim
   delivery stays unconditional.

### The append-only floor is owed to a revision, not to a replacement (RUFU-233 code-review P0)

The clip above was written as if every contradiction inside branch 4 were the *same* block's text changing
under a sink that already holds its head. It is not. Branch 4 admits two shapes whose correct hand-off is
opposite, and clipping both re-opened the lossless half of the contract:

- **REVISION** — a contradiction arriving at `text_delta`, `text_end`, or `message_end` for the block
  instance currently being streamed. The floor above applies: the row holds the agreed head, so only the
  divergence run may follow it.
- **REPLACEMENT** — the next message's block reusing an index because the producer shares one `partial`
  object across messages with no `message_start`/`message_end` between. Its leading characters were never
  this message's text, so clipping them against the previous message's span is plain deletion. Measured on
  the shape this file already carries: delivered `"notes/origin/using-39"` replaced by
  `"notes/origin/README.md"` emitted `notes/origin/using-39README.md` — **13 characters of a genuine new
  reply dropped** — and a replacement that is a prefix of the previous block (`"notes/origin"`) clipped to
  `""`, so the new message reached **no sink at all**: RUFU-234's `stale-ledger-hole-shorter-replacement`
  total-loss outcome, worse than the head-slice branch 4 was written to fix. Two consecutive replies that
  begin with the same words are ordinary for one model, so this is the shape's common case, not an edge;
  the RUFU-234 pair survived only because `"OK"` shares no prefix with `"notes/origin/using-39"`.

The discriminator is the event, not the text: a real stream opens a block exactly once per message, and the
ledger is cleared by `message_start`/`message_end`, so **a second `${kind}_start` for a (kind, index) whose
ledger is already populated inside one message can only announce a new block instance**. `advance` takes
that as `announcesReplacement` and, for it alone, restarts the block's ledger and hands the replacement
whole — RUFU-234's length-independent rule, restored. The event-based test costs nothing else: copied
snapshot providers still share one ledger because identity is never consulted.

Two boundaries survive and are stated rather than papered over:

1. A replacement whose `text_start` is never emitted — the new message appears only as deltas on the stale
   index — is indistinguishable from a revision by any signal this seam receives, so it keeps the clip and
   the row can lose the shared head. Nothing in the event vocabulary separates them; guessing from length or
   from `consumed` would re-buy the loss with duplication on the revision face.
2. The floor itself is unchanged for a revision: one divergence span per revision is the most an
   append-only row can carry.

<!--
FNXC:AssistantTextCapture 2026-11-03-22:26:
RUFU-233 code-review P0 remediation recorded here because this file is the seam's contract: the
`novelSpan` clip introduced earlier the same day applied the append-only floor to a whole class it does not
own. `announcesReplacement` (set at the `${kind}_start` call site from the populated-ledger condition) now
splits branch 4, and both halves are pinned in assistant-text-capture-fidelity.test.ts — each replacement
case RED on the clip-only build (measured: `notes/origin/using-39README.md` and a wholly dropped prefix
replacement) and the revision case green on both builds, so neither half can silently take the other back.
-->

### Coverage this card added (and one methodological lesson)

- `agent-log-round-trip-fidelity.test.ts` — real capture → real `AgentLogger` → real
  `appendAgentLogEntriesSync` → real `readAgentLogEntries` over a temp task dir, plus the operator read
  route (`buildTaskAgentLogReadText`, previously tested only by `vi.fn(() => "")` stubs), the
  token-straddling-two-rows case, the 500 ms timer flush under fake timers, and the branch-a4
  cross-runtime bridge exactly-once replay. No `node:fs` mock anywhere in the file.
- `heartbeat-text-fidelity.test.ts` and `triage-text-fidelity.test.ts` — the two lanes that had no
  fidelity test, each asserting its own `onText` wiring against a real file round-trip. The executor lane
  asserts the entry-handoff seam; disk bytes for that shape are the shared round-trip file's job.
- RUFU-208's flush levers (`FLUSH_SIZE_BYTES`, `FLUSH_INTERVAL_MS`, `ENTRY_BATCH_SIZE`) and the append
  strategy are untouched; every test drives them through the constructor's overrides.
- **Lesson for the next fidelity suite:** the executor-lane fidelity case was written long before it ever
  ran, and it was vacuous — a hand-enumerated module mock upstream (`executor-test-helpers.ts`) starved
  the lane so the test died before reaching streamed text. A zero-executed-test check is worth more than
  another assertion; the helper now uses `importOriginal` + spread.
