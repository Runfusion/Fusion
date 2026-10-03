---
title: "pi refuses a second compaction; tier 3 recovers via public appendCompaction plus the live-view write"
date: 2026-09-04
problem_type: reliability
module: "@fusion/engine"
component: chat-context-guard
tags:
  - chat
  - compaction
  - context-overflow
  - pi
  - deterministic-fallback
  - tier-3
symptoms:
  - "chat send refused with CHAT_CONTEXT_OVERFLOW reason=already-compacted while the loaded message list is still far over the threshold"
  - "session permanently unsendable: every send is refused before the prompt runs, so the user cannot even ask to switch models"
  - "pi reports 'Already compacted' although a reduction is still arithmetically possible"
root_cause: "pi compares message-only tokens against its keep-recent budget without subtracting the static prompt/tool floor, and it refuses any second compact() once the transcript carries a CompactionEntry — so an LLM-pass failure leaves no pi-side path to a smaller context."
resolution_type: code_fix
---

## The constraint

pi's `session.compact()` refuses with `"Already compacted"` as soon as the active transcript
carries a `CompactionEntry`. The refusal is absolute: no consolidation directive, aggressive or
otherwise, unlocks a second LLM pass (RUFU-182 documented that in the operator guide). Combined
with the measurement asymmetry — pi's token check ignores the static prompt/tool floor it will
still send — a session whose summarizer fails can sit permanently unsendable even though cutting
message history would provably fit (real case: saneca chat `chat-b6a74d40`, refused at 221% of
the hard limit with 110,034 message tokens loaded).

## Routes considered and why they were rejected

- **`session.compact()` from tier 3** — the same public call tiers 1–2 use; it hits the identical
  `"Already compacted"` wall, so tier 3 must never call it (banned in the guard).
- **`_appendEntry` on the session manager** — the underscore prefix is private pi internals; using
  it would be a back door into a dependency we do not own. Banned outright.
- **`newSession` with a truncated history** — public, but rejected: supersession of the prior
  compaction entry is already carried by the public `firstKeptEntryId`, and a gate may not open
  branches. `appendMessage` is likewise absent from the gate's allowed manager surface — tier 3
  cannot drop history outside `appendCompaction`.

## The adopted route (Route A)

`runDeterministicFallback` in `packages/engine/src/chat-context-guard.ts` mirrors pi's own
`compact()` tail using exactly five public members of `SessionManager` (`CompactionGateSessionManager`)
and no private ones: `buildContextEntries` (the active, compaction-aware leaf view to split),
`getEntries` + `getLeafId` (real leaf-path order, needed to place the split past any live
compaction — `buildSessionPath`/`getBranch` are not exported), `appendCompaction` (the only append
it may use), and `buildSessionContext` (the rebuilt message list to install into the live view):

1. Plan deterministically: `buildDeterministicFallbackCompaction`
   (`packages/engine/src/chat-context-deterministic-fallback.ts`) splits the active entries at a
   turn boundary so `digestTokens + keptTokens < compactionTarget - staticFloor` holds by
   construction, priced with pi's own estimator. Zero model calls; the module imports only pure
   helpers, and its test file asserts exactly that import surface.
2. Append durably via the public `appendCompaction(summary, firstKeptEntryId, tokensBefore,
   details, fromHook: true)` — the same tail pi's `compact()` uses.
3. Re-read rather than assume: rebuild the message list through the public
   `buildSessionContext()`.
4. Install the live view with `session.state.messages =` — pi's own in-memory refresh is exactly
   this direct write with no event or handler, so replaying an event would be fiction. This
   write is the sanctioned live-view install.
5. Prove it: `freshLoadedContextEstimate(session)` must land under the compaction target BEFORE
   the send; an unproven attempt keeps the arm's honest refusal (`truncated-unproven`) because
   Route A cannot un-append a durable compaction.

## Testing traps found while proving route integrity

- pi's `estimateTokens` iterates assistant message **content blocks**; a string-content assistant
  message estimates as **0 tokens**. Route-integrity fixtures must seed assistant messages with
  array blocks (`[{ type: "text", text: … }]`) or the arithmetic silently proves nothing.
- pi's session file is lazily written (`_persist`): the JSONL only exists after the first
  **assistant** message. A fixture that appends only user turns finds no file to audit.
- `loadEntriesFromFile` is not exported from pi; the route-integrity test parses the session JSONL
  manually to assert the `CompactionEntry` landed with `fromHook: true`.

## Where it lives

- Plan builder: `packages/engine/src/chat-context-deterministic-fallback.ts` (+ unit tests).
- Route A + refusal overlays: `runDeterministicFallback` in `packages/engine/src/chat-context-guard.ts`
  (`FNXC:ChatOverflowCompaction 2026-09-04-19:20`).
- Behaviour: `packages/engine/src/__tests__/chat-context-guard-tier3.test.ts`,
  `chat-context-deterministic-fallback.test.ts`, and the pi contract file
  `pi-compaction-contract.test.ts` (real pi, real JSONL).
- Operator-visible disclosure and guide contract: `docs/dashboard-guide.md`
  (`FNXC:ChatContextGuardTier3`), upstream design: `docs/solutions/logic-errors/chat-pre-overflow-compaction-blindness.md`.
