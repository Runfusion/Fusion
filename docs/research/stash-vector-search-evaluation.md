# Stash vector/semantic search evaluation (RUFU-126)

**Date:** 2026-08-19 (UTC)
**Status:** Decision + opt-in prototype delivered. Live-instance rollout is operator-gated (see checklist below).
**Companion task documents:** `plan` (full spec), `docs` (condensed evidence + upstream handoff + preflight re-verification) in the RUFU-126 task.

## Why this evaluation exists

RUFU-121 normalized Stash recall queries to single-keyword / explicit-`OR` ASCII for Postgres
`websearch_to_tsquery('english')` (Stash `GET /api/v1/me/sessions/events/search`). That is
keyword-only by construction: a multi-word semantic query like `LCM B.1 B.2 priorita plan`
matches on the first keyword (`LCM`) only, so events that mention the same concepts under
different words never surface — the observed failure mode that forced agents to grep disk for
memory recall. There is no fix inside the keyword endpoint's semantics; a vector/semantic
path is the only route to concept-based recall. This document records, with evidence, whether
the deployed Stash backend can serve that path, the decisions made, and the rollout steps the
operator still owns.

## 1. Upstream foundation inventory (Stash `main` @ a3094990e9b26308dbef9ff9d5a40a2753e58970)

Verified read-only from a dedicated worktree of the local clone
(`/home/schindler/git/stash/.worktrees/fusion-rufu-126`), primary checkout left untouched.

The Stash backend already ships **all of the vector infrastructure** — it is simply not
exposed for session events, not bundled in the image, and never backfilled:

| Component | Location (Stash repo) | State on main |
|---|---|---|
| `history_events.embedding vector(384)` | `backend/migrations/versions/0001_initial_schema.py` (L296) | present since initial schema |
| HNSW cosine index `idx_history_events_embedding … WHERE embedding IS NOT NULL` | `0001_initial_schema.py` (L517) | present (partial index — empty corpus = zero index cost) |
| `content_hash` / `embed_stale` gating columns + `idx_history_events_embed_stale` | `backend/migrations/versions/0016_embedding_content_hash.py` | present |
| `memory_service.search_scope_events_vector(owner_user_id, user_id, query_embedding, limit=20)` | `backend/services/memory_service.py` (L657) | **zero callers** (verified by repo-wide grep). `1 - (embedding <=> $2) AS similarity`, `embedding IS NOT NULL`, scope-isolated via `owner_user_id = $1` + `readable_session_event_condition`, `ORDER BY embedding <=> $2 LIMIT $3` |
| Write-time embedding pipeline | `memory_service.push_event` (L154) / `push_events_batch` (L232): `if embedding_service.is_configured(): _schedule_event_embed(…)` (fire-and-forget; failure flips `embed_stale = TRUE`) | present but gated on `is_configured()` |
| Beat reconciler | `backend/tasks/embeddings.py` (`reconcile()`, Celery Beat every 60s): `_reconcile_history_events` selects `WHERE embed_stale LIMIT 32`, `LEFT(content, 6000)` (MAX_TEXT_CHARS), hash-gated; early-returns 0 when `not embedding_service.is_configured()` | present, but **only retries `embed_stale = TRUE` rows** — never `embedding IS NULL AND embed_stale = FALSE` |
| Provider auto-detection chain | `backend/services/embeddings/auto.py`: `EMBEDDING_PROVIDER` (default `auto`) → `OPENAI_API_KEY`/`EMBEDDING_API_KEY` → openai_compat; `HF_TOKEN` → huggingface; else → **local** sentence-transformers (`all-MiniLM-L6-v2`, 384 dims). `LocalEmbedder.is_configured()` is true iff `sentence_transformers` imports | present |
| Unexposed endpoint precedent | `backend/routers/files_tree.py:642` — `GET /me/pages/semantic-search`: 503 "Embedding service not configured" when `not embedding_service.is_configured()`; `query_embedding = await embedding_service.embed_text(q)`; 500 "Failed to embed query" when None; raw rows | present in deployed OpenAPI (also `/me/tables/{table_id}/rows/semantic-search`) |
| Response model | `backend/models.py` — `HistoryEventResponse` **already has `rank: float | None = None`**; `HistoryEventListResponse` = `{events, has_more}`. FTS `search_scope_events` already returns `ts_rank(…) AS rank` in row dicts | no model change needed — vector rows return `similarity`, the new router maps it into `rank` |
| **Gap 1 — endpoint** | no `GET /me/sessions/events/semantic-search` route in `backend/routers/memory.py` | **absent** (404 baseline, verified live) |
| **Gap 2 — embedder dependency** | `backend/requirements.txt` (36 lines) contains **no `sentence-transformers`**; `backend/Dockerfile` L27 installs from that file | **absent** — the zero-API-key local path (what `auto` resolves to on a self-hosted box) can never become configured |
| **Gap 3 — backfill** | no task touches `history_events` rows with `embedding IS NULL AND embed_stale = FALSE` | **absent** — the pre-existing corpus stays invisible to vector search forever |

> Spec note: the RUFU-126 PROMPT cited `migrations/0011_embeddings.sql` / `0013` / `0014`;
> the actual alembic versions are `0001_initial_schema.py` (embedding column + HNSW index)
> and `0016_embedding_content_hash.py` (content_hash/embed_stale). Same facts, corrected paths.
> The PROMPT also cited `search_scope_events_vector(owner_user_id, query_embedding, limit,
> viewer_user_id)`; the actual main signature is
> `search_scope_events_vector(owner_user_id, user_id, query_embedding, limit=20)`.

## 2. Deployed instance evidence (read-only re-verification, 2026-08-19 10:01–10:05 UTC)

All checks executed read-only against the live deployment; nothing was modified.

| Check | Result (2026-08-19) | 2026-08-18 baseline |
|---|---|---|
| Containers | `stash-backend-1` (API :3456, healthy, `ghcr.io/fergana-labs/stash-backend:0.1.362`, up 5 days), `stash-worker-1` + `stash-beat-1` (same image), `stash-frontend-1` (:3457, 0.1.362), `stash-postgres-1` (pgvector/pg16, healthy), `stash-redis-1`, `stash-collab-1` | same container set |
| OpenAPI | `GET http://127.0.0.1:3456/openapi.json` → **200, 242 paths**. **Divergence:** the spec moved from `/api/v1/openapi.json` (200 on 2026-08-18) to `/openapi.json`; the old path now 404s | 200 at the old path |
| `/api/v1/me/sessions/events/semantic-search` | **ABSENT** from OpenAPI → pre-patch 404 baseline holds | absent |
| Precedent endpoints | `/api/v1/me/pages/semantic-search`, `/api/v1/me/tables/{table_id}/rows/semantic-search` present | present |
| Keyword endpoint | `/api/v1/me/sessions/events/search` present; 401 without auth (frontend :3457 proxies `/api/v1/*` to the backend, so `DEFAULT_STASH_URL` = `http://127.0.0.1:3457` remains a valid API base URL) | present |
| Embedder in container | `docker exec stash-backend-1 python3 -c "import sentence_transformers"` → `ModuleNotFoundError` | not installed |
| Embedding envs | `env` in `stash-backend-1`: no `EMBEDDING_*`, no `OPENAI_API_KEY`, no `HF_TOKEN` → `embedding_service.is_configured()` = **False** → write-time embedding disabled | same |
| Corpus | read-only `SELECT count(*) AS total, count(embedding) AS embedded, count(*) FILTER (WHERE embed_stale) AS stale, min(created_at)::date, max(created_at)::date FROM history_events` → **total=134, embedded=0, stale=0, 2026-07-09 → 2026-08-19** | total=126, embedded=0, stale=0 |

Corpus grew 126 → 134 between verifications and is **still 100% unembedded** — consistent
with the embedder being absent on every write since 2026-07-09.

## 3. Decisions (D1–D5)

### D1 — Separate endpoint, not a `mode=vector` parameter

`GET /api/v1/me/sessions/events/semantic-search?q=&limit=` as a **new path**, mirroring the
in-repo `/me/pages/semantic-search` precedent.

**Rejected alternative — `mode=vector` param on `/events/search`:** FastAPI silently ignores
undeclared query parameters, so a `mode=vector` request against an *unpatched* server would
return keyword results **mislabeled as vector** — the client could not distinguish "vector
search returned keyword-shaped data" from real vector results, and there is no contract-level
way to detect the mode was ignored. A new path 404s cleanly on an unpatched server (detectable
capability), matches the precedent already shipped for pages, and keeps the keyword endpoint's
wire contract (normalized `q`, limit cap, fail-closed behavior) untouched.

### D2 — Vector-first applies only to multi-word queries

The vector branch fires only when the **trimmed raw query has ≥2 whitespace-separated
tokens**. Single-word queries stay keyword-only.

**Rejected alternative — vector for all queries:** for a single token, exact-token FTS is the
best available baseline (the word either is there or isn't); a vector round-trip adds embed
latency + API cost with no recall upside, and it would change behavior for the common
single-word probe (`exists()`-style reads, one-word lookups).

### D3 — Opt-in `stashVectorSearch` project setting (default `false`), not auto-detection

An explicit boolean project setting gates the whole vector path. **Default off = zero behavior
change** until the operator enables it: this is a prototype, and enabling it is a per-project,
visible, one-line, instantly reversible decision.

**Rejected alternative — automatic capability detection (e.g. probe the semantic endpoint,
cache the answer):** changes default behavior for every project (no longer zero-risk), pays a
per-process 404 round-trip cost against unpatched servers, hides the decision behind
implication instead of a setting, and couples "is the server patched?" to "is the feature
wanted?" — two orthogonal questions.

### D4 — The upstream patch closes three gaps

1. **Endpoint** — `GET /me/sessions/events/semantic-search` in `backend/routers/memory.py`,
   mirroring `search_events` auth/isolation (`Depends(get_current_user)` +
   `Depends(get_scope)` + `_check_member`) and the pages-semantic-search error contract (503
   when the embedder is unconfigured, 500 when the query embedding fails), returning
   `HistoryEventListResponse` with each row's `similarity` mapped into the existing `rank`
   field.
2. **Embedder dependency** — `sentence-transformers` added to `backend/requirements.txt`
   (installed by `backend/Dockerfile` L27). This is the zero-API-key path that `auto`
   provider detection resolves to on a self-hosted deployment; no operator env changes needed.
3. **Backfill** — a bounded, idempotent `history_events` backfill task for rows with
   `embedding IS NULL` (batch 32, `LEFT(content, MAX_TEXT_CHARS)` + content-hash gating, same
   shape as the reconciler). This is load-bearing: the 60s Beat reconciler only retries
   `embed_stale = TRUE` rows, so the pre-existing corpus (134 rows, all unembedded, all
   `embed_stale = FALSE`) would otherwise **stay invisible to vector search forever**.

### D5 — Score mapping and scale caveat

Vector hits map the response `rank` (= cosine similarity, 0..1) directly to
`MemorySearchResult.score`; the keyword path keeps its positional scores (2.0 for rank 0, 1.0
for rank ≥1). **The scales differ.** Consumers that apply client-side minimum-score filters
(e.g. RUFU-120 per-turn recall) must treat the score scale as per-backend: a threshold tuned
for the keyword scale (2/1) does not transfer to the similarity scale (0..1). Missing or
non-finite `rank` → `1.0` (neutral, never NaN-poisons a sort).

## 4. Fusion wiring design (RUFU-126 Step 4)

- `StashMemoryBackend` gains a `vectorSearch?: boolean` constructor option (default `false`).
- `search()` vector-first branch, **before** the existing keyword path: flag on **and**
  ≥2 whitespace-separated tokens in the trimmed raw query **and** no negative-cache hit →
  `GET /api/v1/me/sessions/events/semantic-search?q=<raw trimmed, capped at 200 chars>&limit=<same
  computed limit>` through the same `StashHttpClient` seam.
  - 2xx with a non-empty `events`/`results` array → map to `MemorySearchResult[]` in the same
    shape as the keyword path (`path: stash://session/<session_id> | stash://event/<id>`,
    `lineStart`/`lineEnd: 1`, `snippet: (content ?? snippet ?? "").substring(0, 500)`,
    `score: Number.isFinite(rank) ? rank : 1.0`, `backend: "stash"`) and **return**.
  - **Any** vector failure — network error/timeout, non-2xx, malformed body, or an empty
    result list — falls through to the existing RUFU-121 keyword path **byte-identical**
    (normalized `q` via `normalizeStashSearchQuery`, legacy empty-query URL, limit cap,
    fail-closed `[]`). The vector path can therefore never make recall worse than the keyword
    baseline.
  - **Negative-capability cache** (per-process `Map` keyed by `baseUrl`, TTL 1h,
    `__resetVectorCapabilityCacheForTests` test seam mirroring the folder-cache pattern):
    recorded **only** for statuses {404, 405, 501, 503} (parsed from the
    `Stash returned <code>:` error prefix) — i.e. "this server cannot do vector search at
    all". 422/500 and network errors are **never** cached (transient/malformed, retry next
    call). Single-word queries never attempt vector. Flag off → keyword path only.
- `resolveMemoryBackend` stash branch:
  `new StashMemoryBackend({ baseUrl, apiKey, vectorSearch: settings?.["stashVectorSearch"] === true })`.
- `settings-schema.ts`: `stashVectorSearch: false` immediately after the `stashApiKey: ""`
  line (schema-only, consistent with `stashUrl`/`stashApiKey` which also lack UI rows).

## 5. Operator rollout checklist (this task does NOT execute any of it)

1. **Merge upstream:** review and merge Stash branch
   `fusion-rufu-126-sessions-semantic-search` (local worktree
   `/home/schindler/git/stash/.worktrees/fusion-rufu-126`, base `main` @ a3094990).
2. **Rebuild image:** build + push a new `ghcr.io/fergana-labs/stash-backend` tag (maintainer
   action) and redeploy `stash-backend-1` / `stash-worker-1` / `stash-beat-1` (worker and beat
   share the backend image — the backfill task and the reconciler both need the new dep).
3. **Verify embedder:** `docker exec stash-backend-1 python3 -c "import sentence_transformers"`.
   First embed downloads `all-MiniLM-L6-v2` (~90 MB from HuggingFace) — confirm egress and a
   writable model cache.
4. **Backfill:** trigger the one-shot backfill task
   (`backend.tasks.embeddings.backfill_history_event_embeddings`) and verify
   `count(embedding)` grows from 0 toward the corpus total (134 at verification time).
5. **Verify endpoint:** `GET http://127.0.0.1:3456/openapi.json` lists
   `/api/v1/me/sessions/events/semantic-search`; smoke-test a query with the project's API key
   (also reachable via the frontend proxy on :3457).
6. **Enable flag:** set project setting `stashVectorSearch: true`; verify multi-word recall
   (e.g. `LCM B.1 B.2 priorita plan`) returns concept-matched events.
7. **Rollback:** client-side kill switch = set `stashVectorSearch: false` (immediate, no server
   change — the keyword baseline resumes). Server-side rollback is independent (redeploy old
   image); the backfilled embeddings are inert unless vector search is used.

## 6. Out of scope (recorded, not done here)

- Live-instance changes (image rebuild, env, backfill execution, flag enablement) — operator
  task.
- `mode=vector` param, topic filtering on the vector path, MCP surface, TencentDB port.
- Settings UI row for `stashVectorSearch` (schema-only, consistent with the other Stash keys).
- Per-event scores on the keyword `/events/search` endpoint (candidate follow-up; see task).
