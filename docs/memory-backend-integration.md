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

<!-- FNXC:MemoryBackendIntegration 2026-10-12-03:46:
RUFU-461 arrived describing a `memctx_save` tool that kept rewriting one note file as a Stash/Fusion bug.
`memctx_save` is neither: it belongs to the third-party `weauratech/pi-memctx` pi extension, and Stash is an
event store with no note files at all. An operator debugging "a memory save rewrote my note" needs to know
which store they are in before reading code, so the boundary between Fusion's memory backends and third-party
pi memory plugins is documented as a section rather than left to be discovered. -->

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

## 5. Per-conversation memory focus (read-time ranking bias)

Fusion implements **conversation focus** as an opt-in feature. Enable
`experimentalFeatures.chatFocus` in **Settings → Experimental Features** to show its composer
control and bias its proactive recall; the flag is default off, and persisted focus values are inert
until it is enabled. The focus is persisted per chat session via the schema migration
**`0059_chat_session_memory_focus.sql`** (`SCHEMA_BASELINE_VERSION` = `0059`), which adds a
`memory_focus` column to the chat-session table.

At read time, the memory topic / focus (the text an operator or model optimizes a conversation
around) is a **ranking bias, never a filter** (RUFU-172). The proactive per-turn recall cue runs
two searches over the whole project: lane P (keywords derived from the current message/step) and,
when a focus is active, lane T (whose query is the focus's own content terms joined by `OR`,
so the keyword backend's normalization preserves each of them — RUFU-173). Lane T entries lead the cue and
may take at most 60% of its 800-char budget, so whole-project memory always keeps its share —
nothing is hidden. Clearing the focus (empty / `all` / `*`) restores the single-search cue byte for
byte. The stale claim that the focus is a "Stash search topic parameter" performing read-time
scoping is removed: RUFU-121 dropped the inert `&topic=` push-down (the Stash search route accepts
`q` + `limit` only) and no backend filters by topic; the tool-level `topic` option remains a
hint for topic-aware backends.

**Lane T query shape (RUFU-173).** The focus's content terms are extracted with a Unicode-aware
tokenizer (diacritic letters stay inside their word; a hyphen-joined word stays one term),
stopwords and tokens under 3 characters are dropped, terms dedupe case-insensitively in the
focus's own word order, and up to 3 terms (each ≤24 chars) are joined with a single uppercase
`" OR "` inside a 96-character joined budget — trailing terms are dropped whole, never truncated.
Why `OR`: with `stashVectorSearch` off (the deployed configuration) the keyword path runs
`normalizeStashSearchQuery`, which keeps **only the first word token** of a query unless a token
is literally `OR` — so RUFU-172's raw-phrase lane T collapsed a multi-word focus to one term in
exactly the configuration operators run. The backend's OR-preserving branch is the sanctioned
extension point: no Stash change and no change to RUFU-121's normalization contract. The joiner
survives that normalization because the server's non-ASCII strip runs *before* whitespace
collapse and token split, and `" OR "` is pure ASCII. The 96-char client budget sits inside the
server's 100-character token-boundary cap (which silently drops trailing terms), so every
term the client emits reaches the search. When no focus term survives (stopword-only focus),
lane T is **skipped entirely** — one search total — rather than sending an empty query, which
would hit the legacy broad-recall path and inject non-topical hits into lane T's lead slot. A
focus with a single usable token keeps the exact query string RUFU-172 sent, byte-identically.
Accepted consequence: one query string feeds both backend branches, so when `stashVectorSearch`
is enabled the semantic endpoint receives the OR-joined text including the literal `OR` tokens
(the ≥2-token vector gate is unregressed and diacritics still arrive intact). Residual
limitation, recorded not hidden: the server's non-ASCII strip does not transliterate, so a
diacritic term still arrives mangled (`pamäťové` → `pamov`); the OR join rescues the focus's
other surviving terms instead of collapsing the whole focus onto that one mangled term. True
diacritic keyword matching is the Stash-side deferred follow-up listed below.

> Note: `0049_chat_session_memory_focus.sql` is a clean-rebase-only artifact name and does **not**
> exist on this target. Origin's `0049` remains `0049_fn_8864_agent_activity_events.sql`. The
> memory-focus migration here is the new `0059_*.sql`, and no `0048_*.sql`–`0058_*.sql`
> migration was deleted or modified.

**Deferred follow-ups (tracked, deliberately not built):**

1. Mission-context executor focus — deriving an honest focus for the executor lane
   (RUFU-172 passes none; inventing one would fabricate bias).
2. Hard `metadata @> topic` filtering — index-backed corpus isolation; regresses recall today
   because no historical events carry topics (RUFU-172 non-goal).
3. Enabling `stashVectorSearch` — an operator config action, separate from any code change.
4. Stash-side raw-query passthrough / unaccent-aware keyword matching (`search_events`
   normalized-query-off or `unaccent`/`pg_trgm` matching) — the durable fix for diacritic
   keyword matching that RUFU-173 cannot deliver from this repo: the keyword normalizer strips
   non-ASCII characters without transliteration (`pamäťové` → `pamov`), so a diacritic focus
   term still cannot match its Slovak lexeme on the keyword path. RUFU-173's OR-joined lane T
   keeps every *surviving* focus lexeme as its own term instead of collapsing the focus onto
   one, but it does not restore diacritic matching. Crosses repositories and the RUFU-121
   normalization contract, so it stays a tracked follow-up rather than being silently dropped.

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

---

## 7. What is *not* a Fusion memory backend

A memory-shaped symptom in an operator's editor is not automatically Fusion's. Fusion's only wired
memory backend is Stash (§1), and Stash stores **events** (`event_type` / `agent_name` / `session_id`)
against a session — it has no note files, no note bodies, and no save tool an agent can call by name.

Third-party pi extensions can ship their own local memory store alongside Fusion. `weauratech/pi-memctx`
is one: it writes Markdown notes into a local *pack* (`00-system/`, `20-context/`, `40-actions/`,
`50-decisions/`, `60-observations/`, `70-runbooks/`) and exposes a `memctx_save` tool. When triaging a
report about a memory save, identify the writer first — the tool name and the response text decide which
codebase owns the bug:

| observation | owner |
| --- | --- |
| `POST /api/v1/me/sessions/events/batch` payload, `/sessions/<id>` GUI rows, HTTP `422` on a missing `event_type` | Fusion → Stash (this document) |
| a `memctx_save` call, an `Updated existing note: <rel>` response, `## Update (…)` blocks inside a `.md` note | the pi memory plugin, not Fusion and not Stash |

### The note-size ceiling is the store's, not a policy knob

Fusion caps a stored note body at **1 MiB**: `NOTE_CONTENT_MAX_LENGTH` in
`packages/core/src/notes/note-types.ts`, enforced in PostgreSQL by the CHECK constraint
`notes_content_length <= 1048576`. Any memory integration that stores a *note-shaped* body faces the same
boundary, whichever store it writes through.

That ceiling is why a memory plugin must be note-granular rather than append-oriented. A save path that
rewrites an existing note on every similar save grows one file without bound; the file eventually crosses
the cap of whatever holds it, and the memory system then fails **on the memory it is supposed to protect** —
a repeatedly-saved topic becomes the one thing that can no longer be saved, and truncating the oversized
body in response destroys the history it is storing. The contract that keeps a pack healthy:

- **one memory is one new note** — a colliding filename gets a `-2`/`-3` name, never a merge;
- **similarity is reported, not merged** — the response names the closest existing note so linking stays
  deliberate;
- **an oversized new note is refused**, with its byte size, and nothing partial is written;
- **an oversized note already on disk is an operator repair** — a plugin reports it and leaves the file
  byte-identical rather than hand-splitting, trimming, or growing it.

### RUFU-461 (worked example)

The reported symptom — `memctx_save` responding `Updated existing note` and rewriting a 1.3 MB blob — was
traced to `weauratech/pi-memctx@main`, where save-target selection was a fuzzy term-overlap match
(`findSimilarNote`) whose result was appended to under `## Update (<timestamp>)`, and where every turn with
several saves appended a further `## Related learned memories` section to each note. Two unbounded writers,
one file, one refusal.

Nothing on the Fusion or Stash side needed changing: the fix belongs to the upstream plugin, and it shipped
as a `git format-patch` artifact on card RUFU-461 (`git am` applies it; no push, fork, or PR was performed
from a Fusion task session). Fusion's own note store keeps its 1 MiB cap and its refusal semantics
unchanged. If an integration needs to *split* content, splitting stays a deliberate, human-visible act on
the pack — not something the save path does silently to make a write fit.