---
title: "Chat JSONB persistence must strip U+0000 at every PostgreSQL boundary"
date: 2026-08-05
problem_type: reliability
module: "@fusion/core"
component: chat-persistence
tags:
  - postgres
  - jsonb
  - chat
  - nul
  - checkpoints
symptoms:
  - "unsupported Unicode escape sequence during chat session checkpointing"
  - "unhandled rejection after a tool reads NUL-bearing output"
root_cause: "Raw model and tool text reached PostgreSQL jsonb bindings without U+0000 sanitization, while fire-and-forget checkpoint promises had no rejection observer."
resolution_type: code_fix
---

## Problem

PostgreSQL rejects U+0000 in `text` and `jsonb`. Chat tool results are arbitrary environment-controlled output, so a tool reading redirected Fusion logs can include the logger marker `\u0000fnlvl=info\u0000`. Persisting that result in an in-flight generation snapshot caused the checkpoint write to reject; because checkpoints are intentionally fire-and-forget, the dashboard then emitted an unhandled rejection.

## Protected surfaces

The invariant belongs at PostgreSQL persistence boundaries, not provider callbacks. `sanitizeJsonbValue` now recursively strips U+0000 from JSONB values and keys before chat-session snapshot creation/checkpoint writes, message and room-message inserts, attachment appends, and message metadata merges. This covers direct chat, QuickChat, all provider callbacks, and future tool providers without mutating the caller's value. Clean values retain identity; `null` and `undefined` retain their existing semantics.

## Degradation behavior

In-flight checkpoints are crash-recovery state, not turn control flow. `ChatManager` routes debounced timer writes and immediate flushes through one observing helper. A failed checkpoint emits a concise session-scoped warning without payload or database-error text, drops that attempt, and allows streaming, completion, cancellation, and later clears to continue. It does not retry, wait, or create another scheduler.

## Why strip U+0000

Stripping is deterministic, preserves the readable surrounding tool output, and is already the established PostgreSQL sanitizer behavior. Escaping into a literal sequence would change tool text semantics and still require every reader to understand a special encoding.

## Regression commands

```bash
pnpm --filter @fusion/core exec vitest run src/__tests__/nul-sanitize.test.ts --silent=passed-only --reporter=default
pnpm --filter @fusion/core exec vitest run src/__tests__/postgres/chat-store-content-search-edit.pg.test.ts --silent=passed-only --reporter=default
pnpm --filter @fusion/dashboard exec vitest run src/__tests__/chat-manager.test.ts --project dashboard-api-quality --reporter=default --silent=passed-only
```

The PostgreSQL test persists the reported full in-flight tool-result shape and reads it back; dashboard tests exercise both debounced and flush rejection paths with no unhandled rejection.
