---
title: The agent-log read route is append-free — holes inside a stored text row were written, not rendered
date: 2026-10-16
category: logic-errors
module: engine agent-log read route / file store
problem_type: false_premise
component: engine
symptoms:
  - "Persisted `text` rows in `agent-log.jsonl` show scattered 1-4 character drops, lost inter-word spaces, a whitespace inserted inside a token, and a duplicated opening run, while rows of every discrete type in the SAME file are byte-clean"
  - "An operator reading a card's log sees the hole and reasonably suspects the log reader, the truncation helper, or the JSONL writer of eating characters"
  - "A redacted/truncated-looking row invites the conclusion 'the read route clipped it', because the read route is the last code the operator sees before the text"
root_cause: logic_error
resolution_type: test_ratchet
severity: high
related_components:
  - "packages/engine/src/agent-tools.ts"
  - "packages/engine/src/__tests__/agent-log-round-trip-fidelity.test.ts"
  - "packages/engine/src/execution/assistant-text-capture.ts"
  - "packages/core/src/agents/agent-log-file-store.ts"
tags:
  - agent-log
  - read-route
  - forensics
  - streaming
  - rufu-204
  - rufu-233
---

# The agent-log read route is append-free — holes inside a stored text row were written, not rendered

## The premise this card had to falsify

RUFU-233 arrived as "the disk-first layer is losing characters": streamed assistant text reached
`agent-log.jsonl` with holes, so something between the model and the operator was deleting them. The
candidate list looked symmetric — the capture seam, the JSONL writer/reader, or the operator-facing
read route (`buildTaskAgentLogReadText` / `renderAgentLogEntries` in `agent-tools.ts`, which sits behind
`fn_task_logs_read` and the dashboard log panel).

**The read route and the file store are exonerated for every reported row, and the falsification is a
disk fact, not a code reading.** The premise "the read route truncates / re-chunks / redacts streamed
text into holes" is false, and RUFU-204's rule says a falsified premise must be written down rather
than quietly dropped. This file is that record.

## The disk-proof method (reusable, no Fusion code in the path)

Read the file with `json.loads` per line — the same algebra the store's reader uses, but with zero
Fusion code in the path — and let the file itself arbitrate:

1. **Are the holes in the bytes, or only in the rendering?** Parse each line independently and re-check
   the tokens inside the `text` field. If a hole is visible in the raw parsed `text`, no read-side
   function can be its author. In the reported 19.5 MB / 73 668-line evidence file, every holed row was
   already holed at that level.
2. **Compare row classes inside one file, one set of sessions, one runtime face.** Discrete rows are
   written whole by the same writer, through the same read route: 13 042 `tool` / `tool_result` /
   `tool_error` / `status` rows and **0** matched any token-drop detector, while 973 of 60 625 `text`
   rows did. A lossy read/serialize route has no way to corrupt only the buffered streaming face.
   Corroborating detail: `tool` rows spell `fn_task_logs_read` correctly 371 times in the same file that
   contains `fn_logs_read` in a `text` row.
3. **Look for the row-boundary signature of a re-chunking or interleaving writer: `}{`.** Zero
   occurrences across the whole file. An append that split or interleaved a row would leave that marker;
   its absence rules the framing path out by evidence rather than by inspection.
4. **Check whether the truncation helpers can even reach `text`.** `truncateAgentLogDetail` is applied to
   `detail` only, and `redactSecrets` runs on `detail` in `AgentLogger.writeEntry`; no redaction path
   touches `text`. The read route's two real reductions — the 12 000-character whole-payload budget and
   the `detail` preview — both operate outside a row's `text`.
5. **Date every holed row against the remediation clock.** All 1 057 holed rows were produced by code
   without today's fix (the last one lands 11 minutes before a later remediation reached `main`), so the
   population is closed and cannot be re-observed by waiting. When the residual population is closed, the
   remaining question is "does today's code still produce this shape?", which is answered by replaying
   the extracted shapes through current tip — see the `evidence-replay` fixture in
   `packages/engine/src/__tests__/assistant-text-capture-fidelity.test.ts`.

## What the layers actually guarantee

- The writer serializes one whole `JSON.stringify` payload per row and inserts a separator newline when
  the existing tail is unterminated; the reader `JSON.parse`s per line. Neither splits a row.
- The read route renders a row's `text` verbatim. Its two permitted content reductions are documented
  and bounded: the whole-payload budget (`[Output truncated; …]`) and the `detail` preview
  (`AGENT_LOG_READ_DETAIL_PREVIEW_MAX`, lifted by `detail: "full"`). Neither edits the inside of `text`.
- The only permitted difference between the provider's authoritative block text and a stored row is
  whitespace **insertion** by `normalizeStreamingDelta` — insertion only, never deletion.

So a hole inside a stored `text` row names the **capture seam** as its author. That is where RUFU-233's
one production edit landed, and where four prior remediations had already landed
([the post-mortem](stream-capture-trusted-delta-against-stale-block-snapshot.md)).

## The ratchet that replaces the investigation

Exoneration is worthless without a tripwire, and before this card nothing tested these renderers for
fidelity at all — RUFU-208 pinned the *selection algebra* (offset / limit / type / time window /
pagination, newline and line-number integrity), which stays green while every assistant row is mangled,
because it asserts how rows are **chosen** and never what a row **contains**. The CLI lane's coverage was
`vi.fn(() => "")` stubs.

`packages/engine/src/__tests__/agent-log-round-trip-fidelity.test.ts` now covers the claim an operator
actually makes, over a real file boundary with no `node:fs` mock:

- real `createAssistantStreamCapture` → real `AgentLogger` → real `appendAgentLogEntriesSync` → real
  `readAgentLogEntries`;
- every persisted `text` row appears verbatim in the rendered payload, in stream order, with no
  whole-payload truncation marker — the order walk uses a cursor, because a flush-split fragment row
  legitimately recurs as a substring of an earlier row, and a bare `indexOf` would report a false
  reorder;
- a `detail` over the preview budget may be shortened, but the preview must not reach into that row's
  `text`;
- a token that straddles the flush boundary is split across two rows and reassembles byte-for-byte,
  with interleaved `status` and `tool` rows in the same file staying clean;
- the 500 ms timer flush (fake timers, driven through the constructor's `flushIntervalMs` override)
  writes the same bytes as the size flush — the two flush triggers are not a fidelity boundary;
- branch a4: every delta crossing the cross-runtime fallback bridge reaches the terminal sink exactly
  once on both reachable consumer orderings, so the bridge neither re-delivers nor suppresses.

## How to reuse this method

When a log row looks clipped, order the questions this way, because the cheap hypothesis is the wrong
one: (1) read the row's bytes with a parser that is not Fusion's, so no renderer can be blamed or
credited; (2) compare row classes **inside one file** — a loss that hits only rows assembled from
streamed deltas while discrete rows in the same file, same sessions, same writer, are clean cannot come
from a shared writer or reader; (3) look for the physical signature of the writer you suspect (`}{` for
a split or interleaved append); (4) only then read code, and read the guards that decide whether a
helper can reach the field at all (`truncateAgentLogDetail` is `detail`-only; `redactSecrets` runs on
`detail`) before theorising that it does.

The RUFU-204 precedent applies: a falsified premise is a deliverable. Write it down with the command
that falsified it, or the next investigation re-litigates the read route and the capture seam stays
unexamined.