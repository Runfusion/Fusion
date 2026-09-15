---
category: ui-bugs
module: engine/execution
tags: [streaming, pi, anthropic, claude, chat, agent-logs, assistant-text-capture]
problem_type: bug
applies_when: Assistant responses show their first words twice in chat or task logs with a given provider.
---

# Duplicated assistant response prefix in chat and task logs (FN-431)

## Symptom

With some providers — Claude/Anthropic most visibly — the beginning of an assistant response was
appended twice, both while streaming and in the persisted history:

```
I'll researchI'll research the codebase before writing the spec.
```

The duplication appeared in the direct chat, Planning Mode chat, and the task agent logs, because all
of them consume the same engine capture seam.

## Root cause (verified against the locked pi 0.84.4 contract)

`createAssistantStreamCapture` (`packages/engine/src/execution/assistant-text-capture.ts`) treated a
`text_start` snapshot and the following `text_delta` as two independent sources of text:

1. on `text_start` it flushed whatever the event's `partial` snapshot already contained for that
   content block, and
2. on `text_delta` it appended the delta **unconditionally**.

That is safe only if the snapshot observed at start time predates the first delta. It does not:

- `@earendil-works/pi-ai`'s `dist/utils/event-stream.js` queues events **without cloning them**, and the
  agent loop forwards the `assistantMessageEvent` unchanged.
- Anthropic-shaped producers push the *same mutable object* as every event's `partial`
  (`packages/pi-claude-cli/src/event-bridge.ts` pushes `partial: output` for start, delta and stop;
  pi-ai's `dist/api/anthropic-messages.js` behaves the same way).

So a consumer that drains the queue one tick late reads a start snapshot that has **already been
mutated** with the first delta, emits it, and then emits the identical delta again. The same class of
bug affected bursts: the offset bookkeeping advanced to the snapshot length (which can already contain
deltas that have not been consumed yet), so a later delta could be re-emitted or swallowed.

The `partial` object is a *cumulative view*, never proof that its text has not already been delivered.
Start and end events are **not** additional deltas.

## Fix

The capture now reconciles, per (message, content block, kind), two distinct cursors:

- `covered` — how many raw characters of the block have already been emitted, from any event shape;
- `consumed` — how many raw characters have been accounted for by the deltas seen so far.

On a delta the capture checks whether the snapshot is *consistent* with the delta stream
(`full.slice(consumed, consumed + delta.length) === delta`). When it is, the delta occupies the raw
range `[consumed, consumed + delta.length)`, so only the part beyond `covered` is emitted; when it is
not (no snapshot, string `partial` from the mock provider, stale or copied snapshot that does not
line up), the delta is treated as genuinely new text and emitted in full. Start and end events flush
only the remainder beyond `covered`, so a block that never receives a delta is still restored, at the
latest at the block/message end.

Deliberately NOT done:

- no lexical/regex deduplication and no cross-response prefix comparison — intentional repetition
  (`P + P`) and two identical responses stay intact;
- no rewrite of stored history and no migration — only newly streamed text is affected;
- no pi upgrade, no dependency change, no transport rewrite in the provider bridges.

Message identity no longer relies on the JavaScript identity of the `partial` object: providers that
emit a *copied* snapshot per event were otherwise treated as a new message on every event (clearing
the cursors, and inventing paragraph boundaries). Block boundaries are now signalled from the content
index plus a message generation bumped at `message_start`/`message_end` and when a snapshot visibly
restarts (its block text is shorter than what the deltas already consumed).

## Regression matrix

| Scenario | Covered by |
| --- | --- |
| Shared mutable snapshot, start drained after the first delta was queued | `packages/engine/src/__tests__/assistant-text-capture.test.ts` |
| Immediate consumption (no queue lag) | same |
| Snapshot several deltas ahead (burst) | same |
| Copied snapshot per event | same |
| Block with no delta at all, replayed terminal | same |
| Intentional repetition, two identical responses | same |
| Thinking/text/tool interleaving, block and message boundaries | same |
| Mock provider (`partial` as a string), malformed events | same |
| Real pi-claude-cli / Droid / ACP bridges driven end to end | `packages/engine/src/__tests__/assistant-stream-provider-compat.test.ts` |
| Real `createFnAgent` subscription and the model-swap `wireFallbackHooks` path | `packages/engine/src/__tests__/pi.test.ts` |
| Chat streaming, in-flight checkpoint, persisted message | `packages/dashboard/src/__tests__/chat-stream-prefix.test.ts` |
| Client-side reconnect from a checkpoint, identical legitimate fragments | `packages/dashboard/app/hooks/__tests__/createChatStreamHandlers.test.ts` |
| Agent logger down to the real JSONL file (batch and single-entry fallback) | `packages/engine/src/__tests__/agent-logger-stream-prefix.test.ts` |

Planning Mode, the reviewer, workflow-step nodes and the merger all consume the SAME capture through
the same `onText`/`onThinking` callbacks proven above (`createFnAgent` wiring + `AgentLogger`), so they
are covered by composition rather than by a fourth end-to-end replay. The ACP-family bridges
(`plugins/fusion-plugin-*-runtime`) and the callback-only runtime adapters never produce pi `partial`
snapshots — they forward plain deltas — so they are non-regression witnesses and their suites are run
unchanged.

## Related

- `docs/solutions/ui-bugs/chat-streamed-source-link-integrity.md` — the normalizer that repairs
  sentence spacing between deltas; its presentation spaces are deliberately not counted in the raw
  offsets used here.
