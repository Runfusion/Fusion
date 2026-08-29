---
title: Queued chat message flush trusted stale client-side isGenerating
date: 2026-06-03
category: logic-errors
module: dashboard
problem_type: logic_error
component: frontend_stimulus
symptoms:
  - "Queued follow-up message vanishes after back-navigating out of a regular chat and re-entering — not sent, not in the composer (FN-5852, GitHub #1279)"
  - "Re-entering a chat could abort the assistant's in-flight reply mid-stream"
  - "Bug survived two prior fixes (FN-5852, FN-5921) that made the queued draft persist to localStorage"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - chat-store
  - sse
tags:
  - chat
  - queued-messages
  - sse
  - stale-state
  - isgenerating
  - enrichment-fields
  - useChat
  - useQuickChat
---

# Queued chat message flush trusted stale client-side isGenerating

## Problem

Messages queued while the assistant was responding disappeared if the user hit back and re-entered the chat before they were sent. Two prior fixes made the queued draft *persist*, but the restore path still flushed it immediately based on local state, firing a send that aborted the live generation server-side and deleted the persisted copy before the send could fail.

## Symptoms

- Queued bubble gone after back → re-enter; message never sent, persisted localStorage copy deleted
- Original assistant reply could be killed mid-stream on re-entry (server `beginGeneration` aborts the prior generation on any new send)
- Hook-level tests for the exact navigation flow passed while production failed

## What Didn't Work

- **FN-5852** — persisting the queued draft per session in localStorage. Necessary but insufficient: the restore path still flushed from stale state.
- **FN-5921** — removing the eager `removePersistedPendingChatMessage` calls from `resetTransientComposerState`/`selectSession`. Also necessary, also insufficient — same restore-path flaw.
- Both rounds of tests hand-crafted `isGenerating: true` in the client's sessions list, a state production never has mid-generation, so the suite green-lit a broken flow twice.

## Solution

The restore effect in `useChat.ts` / `useQuickChat.ts` no longer flushes from local state. It restores the queued bubble, then calls `fetchChatSession` (authoritative, route-enriched) and decides:

- server says generating → `attachIfGenerating(...)` and let the stream's `onDone`/`onError` flush
- server says idle → flush now
- fetch failed → keep the bubble; a later trigger (stream completion, visibility resume, manual send) delivers it

## Why This Works

`isGenerating` is **not a stored field** — it's a route-level enrichment computed from `ChatManager`'s in-memory generation map (`register-chat-routes.ts`). The `chat:session:updated` SSE event emits the raw `ChatSession` store row (`chat-store.ts` → `sse.ts`), which has no `isGenerating`, and the client handler replaces `sessions[]`/`activeSession` **wholesale** with that payload. So mid-generation, the client's local copy reliably reports `isGenerating: undefined`. Any client logic that gates a side-effecting action on the locally cached flag acts on fiction; only a fresh `GET /chat/sessions/:id` reflects reality.

## Prevention

- **Treat enrichment fields as expired the moment they arrive via any path that doesn't enrich.** Before gating a destructive/irreversible action (sending, deleting, aborting) on a cached server-state flag, re-fetch from the authoritative endpoint.
- **The SSE wholesale-replace is a standing trap**: `handleChatSessionUpdated` overwrites enriched session objects with un-enriched ones, silently degrading `isGenerating` and `lastMessagePreview` for every consumer. Merging instead of replacing (or enriching the SSE payload server-side) would eliminate this class — flagged as a follow-up, not yet done.
- **When a regression test passes but production fails, audit the fixture state against what production can actually contain.** Both prior test rounds modeled an unreachable state; the fixed regression tests model the stale-falsy-flag + server-generating combination.
- Remember `beginGeneration` aborts any in-flight generation for the session — an "extra" client send is never harmless.

## Related Issues

- Runfusion/Fusion#1279 / FN-5852 / FN-5921; fixed in PR Runfusion/Fusion#1387
