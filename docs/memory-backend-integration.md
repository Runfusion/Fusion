# Stash Memory Backend Integration

[← Docs index](./README.md)

Fusion persists AI "memory" — task-completion shots, chat-session transcripts, recall hits,
and per-conversation read focus — to a pluggable memory backend. The only memory backend
currently wired into Fusion is **Stash**, a session-oriented event store. This document is the
canonical operator guide for how Fusion talks to Stash, how it authenticates, how it isolates
projects, and how conversation memory is captured and focused.

There is intentionally **no** TencentDB backend in this build. The backend enum only ever
resolves `stash` (or the default `qmd` no-op); a TencentDB backend type, URL setting, or
integration doc does not exist.

---

## 1. The Stash server

Stash exposes a small HTTP REST API used by Fusion for both read and write of memory events.
All calls are scoped to the authenticated operator's own user id.

- **SEARCH (read):** `GET /api/v1/me/sessions/events/search?q=<query>&limit=<n>`
- **CAPTURE (write):** `POST /api/v1/me/sessions/events/batch`

The events sent to `/events/batch` must conform to a Stash event shape that requires a
top-level `event_type`, `agent_name`, and `session_id` per event; a missing required field is
rejected with HTTP `422`. Fusion sets `agent_name` (default `"fusion"`) and `session_id` on
every event it uploads, so transcripts render correctly in the Stash `/sessions/<sessionId>`
GUI.

## 2. Server URL and configuration

- **Setting key:** `memory.backendType` — the resolved backend type. Only `"stash"` triggers
  Stash capture/recall. Any other value (including the default `"qmd"`) is a no-op for both
  capture and read, and a non-Stash backend never reads secrets.
- **Setting key:** `memory.stashUrl` — the Stash server base URL. When empty, Fusion falls
  back to the default `http://127.0.0.1:3457` (a locally-hosted Stash daemon). The stored
  value is trimmed of trailing slashes.
- **Setting key:** `memory.stashApiKey` — an **optional per-project override** for the API
  key. It is **never committed to source**; it is a runtime setting an operator can provide
  when they do not want to (or cannot) use the global secrets store.

## 3. Authentication

Fusion authenticates to the Stash server with an API key resolved in this precedence order:

1. **Per-project override** `memory.stashApiKey` (settings) — wins if set.
2. **Global secrets store** key `stash-api-key` (scope `global`) — read via the secrets-store
   `revealSecret`. This is the recommended mechanism; the key lives outside the repo in the
   operator's secret store and is never committed.

The API key is **never hardcoded** in Fusion source. Resolution degrades fail-closed: a
missing or undecryptable secret resolves to an empty key (an unauthenticated request), so
capture becomes a no-op rather than an error. Only a Stash backend ever reads secrets — a
non-Stash or memory-disabled project triggers no secret read at all.

## 4. Per-project isolation

Memory events carry a **provenance discriminator** derived from the project root (e.g.
`fusion:<slug>`). The discriminator is **not** the isolation mechanism:

> Stash enforces isolation itself, scoping all reads and writes to the operator's own owner
> user id (`owner_user_id IN accessible_scope_ids_sql(1)`). The Fusion discriminator tag is
> **provenance / grep-ability only** — it lets an operator query "which Fusion project wrote
> this event" — and it is never confused with a required request field.

Because Stash scopes by operator identity, two Fusion projects belonging to different
operators are naturally isolated, while a single operator's projects share the owner scope and
are distinguishable by the discriminator tag.

## 5. Per-conversation memory focus (read-time scoping)

Fusion implements **conversation focus** so a recall hit is scoped to the conversation that
produced it. The focus is persisted per chat session via the schema migration
**`0059_chat_session_memory_focus.sql`** (`SCHEMA_BASELINE_VERSION` = `0059`), which adds a
`memory_focus` column to the chat-session table.

At read time, the memory topic / focus (the text an operator or model optimizes a conversation
around) is applied as a scoping filter on recall, so search within a focused conversation does
not surface unrelated project memory. The focus value is carried through the memory read path
and used as a Stash search topic parameter. This is a **read-time scoping** behavior — it does
not rewrite what is captured, only what a focused conversation recalls.

> Note: `0049_chat_session_memory_focus.sql` is a clean-rebase-only artifact name and does **not**
> exist on this target. Origin's `0049` remains `0049_fn_8864_agent_activity_events.sql`. The
> memory-focus migration here is the new `0059_*.sql`, and no `0048_*.sql`–`0058_*.sql`
> migration was deleted or modified.

## 6. Complete-chat-session capture

Fusion captures **complete chat sessions** into Stash (not merely per-task completion shots).
A chat-store subscription turns the live conversation stream into per-message Stash memory
events:

- **Per-message events** — as each chat message is added, Fusion maps it to a capture event
  (`user_message` / `assistant_message` / `tool_use`, with `agent_name`, `content`, and
  `tool_name` for tool events) and progressively appends it to Stash. `session_id` is the
  **Fusion ChatSession id**, so the Stash `/sessions/<sessionId>` screen shows the full
  transcript.
- **Conversation-close flush** — when a session transitions to a final status (`archived`),
  any remaining buffered-but-not-yet-appended messages are flushed as a final batch. The final
  flush is **idempotent / dedup-safe**: already-appended per-message events are never re-emitted.

Capture is **best-effort / fail-closed / non-blocking**:

- A capture or secret-resolution failure never blocks or fails a chat or task completion.
- A disabled memory backend or a non-Stash backend makes capture a no-op.
- Captured content is written to the memory backend **only** — never to run-audit (run-audit
  rows carry ids/counts/outcomes only, per the FN-7158 rule).

### Per-task completion capture

In addition to chat transcripts, Fusion emits a `task_completion` memory event (session id
`fusion-task-<taskId>`) when a task completes, so a task's finishing state is recorded in the
operator's memory. Like chat capture, this is completion-gated (at most once per task),
best-effort, and non-blocking.