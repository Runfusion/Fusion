# Fusion Memory Plugin Contract

[← Docs index](./README.md)

This document is the source-of-truth contract for Fusion memory backend behavior after the FN-2087 migration series.

---

## Table of Contents

1. [Current Fusion Memory Baseline](#1-current-fusion-memory-baseline)
2. [OpenClaw Research Findings](#2-openclaw-research-findings)
3. [Fusion Memory Plugin Contract](#3-fusion-memory-plugin-contract)
4. [Migration Strategy + Compatibility Guardrails](#4-migration-strategy--compatibility-guardrails)
5. [Downstream Task Alignment](#5-downstream-task-alignment)

---

## 1. Current Fusion Memory Baseline

### 1.1 Two Memory Systems (Distinct Responsibilities)

Fusion currently has two related but distinct memory systems:

1. **Layered memory backend system** (`memory-backend.ts` + `project-memory.ts`)
   - Handles agent-facing read/write/get/search for project memory
   - Canonical layered workspace under `.fusion/memory/`
   - Uses pluggable backends (`file`, `qmd`, `readonly`, custom)
2. **Insight extraction system** (`memory-insights.ts`)
   - Runs scheduled extraction and pruning workflows
   - Reads working memory and writes extracted insights/audit artifacts
   - Independent automation lifecycle and settings

### 1.2 Canonical Constants and Paths

| Constant | Value | Source Module |
|---|---|---|
| `MEMORY_WORKSPACE_PATH` | `.fusion/memory` | `memory-backend.ts` |
| `MEMORY_LONG_TERM_FILENAME` | `MEMORY.md` | `memory-backend.ts` |
| `MEMORY_DREAMS_FILENAME` | `DREAMS.md` | `memory-backend.ts` |
| `DEFAULT_MEMORY_BACKEND` | `qmd` | `memory-backend.ts` |
| `MEMORY_WORKING_PATH` | `.fusion/memory/MEMORY.md` | `memory-insights.ts` |
| `MEMORY_INSIGHTS_PATH` | `.fusion/memory/memory-insights.md` | `memory-insights.ts` |
| `MEMORY_AUDIT_PATH` | `.fusion/memory/memory-audit.md` | `memory-insights.ts` |
| `MEMORY_LONG_TERM_BYTE_BUDGET` | `32768` (32 KiB) | `packages/engine/src/memory/memory-budget.ts` |
| `MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES` | `8388608` (8 MiB) | `packages/engine/src/memory/memory-budget.ts` |
| `MAX_MEMORY_LENGTH` | `50000` characters (UTF-16 code units, not bytes) | `packages/engine/src/agents/agent-instructions.ts` |

### 1.3 Exported Surface (Post-Migration)

#### `project-memory.ts` exports

| Export | Purpose |
|---|---|
| `getDefaultMemoryScaffold()` | Default long-term scaffold content |
| `ensureMemoryFile()` | Filesystem bootstrap for canonical memory |
| `ensureMemoryFileWithBackend()` | Backend-aware bootstrap |
| `readProjectMemoryWithBackend()` | Backend-aware read helper |
| `searchProjectMemory()`, `getProjectMemory()` | Backend-aware search/get wrappers |
| `resolveMemoryInstructionContext()` | Backend-aware instruction context |
| Planning instruction builder | Planning prompt memory instructions |
| `buildExecutionMemoryInstructions()` | Executor prompt memory instructions |
| `buildReviewerMemoryInstructions()` | Reviewer prompt memory instructions |
| `readProjectMemory()` | Direct canonical long-term file read |

#### `memory-backend.ts` key exports

| Export | Purpose |
|---|---|
| `MemoryBackend`, `MemoryBackendCapabilities` | Runtime backend contract |
| `MemoryBackendError`, `MemoryBackendErrorCode` | Typed backend error model |
| `FileMemoryBackend`, `QmdMemoryBackend`, `ReadOnlyMemoryBackend` | Built-in backend implementations |
| `registerMemoryBackend()`, `getMemoryBackend()`, `listMemoryBackendTypes()` | Function-based registry API |
| `resolveMemoryBackend()` | Backend resolution from settings |
| `memoryWorkspacePath()`, `memoryLongTermPath()`, `dailyMemoryPath()`, `memoryDreamsPath()` | Canonical layered path helpers |
| `ensureOpenClawMemoryFiles()` | Layered file bootstrap |
| `listProjectMemoryFiles()`, `readProjectMemoryFile()`, `writeProjectMemoryFile()` | Validated layered file operations |

### 1.4 Settings Baseline

`ProjectSettings` fields that govern memory behavior:

- `memoryEnabled?: boolean` (default `true`)
- `memoryBackendType?: string` (default `"qmd"`)
- `insightExtractionEnabled?: boolean` (default `false`)
- `insightExtractionSchedule?: string` (default `"0 2 * * *"`)
- `insightExtractionMinIntervalMs?: number` (default `86400000`)

Runtime backend resolution uses an internal `MemorySettings` shape with `memoryBackendType` and optional additional keys.

### 1.5 Key Invariants

1. Canonical layered long-term memory file is **`.fusion/memory/MEMORY.md`**.
2. Runtime memory APIs only read/write canonical layered files under `.fusion/memory/`.
3. Default backend is **`qmd`** (`DEFAULT_MEMORY_BACKEND`).
4. Backend selection key is **`memoryBackendType`**.
5. Prompt instruction context is backend-aware (`file` path hint vs `qmd`/`readonly` behavior).
6. Dashboard `/api/memory` routes are backend-aware; layered file routes validate requests against allowed memory workspace files.
7. The long-term `MEMORY.md` byte budget is **code-owned**, not a settings knob. `MEMORY_LONG_TERM_BYTE_BUDGET`
   is the single number both the write path (`fn_memory_append`) and the maintenance path
   (`reconcile-long-term-memory-budget`) compare against, so the append report and the sweep can never
   disagree about what "over budget" means. An append that breaches it still succeeds: the confirmation
   message reports measured bytes, budget, percentage, and entry count instead of refusing to record the
   lesson. Daily-layer files keep their original unmeasured confirmation wording, because the budget is a
   long-term working-set bound and daily files are rolling dated logs. "Over budget" is a write-time and
   maintenance statement only — what actually reaches a model is decided by the injection clamp,
   invariant 9.
8. Long-term memory maintenance is **default-on and loss-free**. It runs from self-healing (startup
   recovery plus maintenance batch 1) rather than from the optional `Memory Keeper` runtime lane, which
   built-in provisioning seeds disabled. It collapses only `## ` sections that are exact duplicates,
   counts same-heading/different-body conflicts instead of choosing between them, and refuses every write
   unless a memory backup covering that file succeeded in the same pass after the bytes were read.
   Within-budget files are never rewritten. See `docs/run-audit.md` → *Long-term memory budget
   maintenance* for the `memory:long-term-*` rows this emits.
9. **The budget and the injection clamp are two different numbers governing two different surfaces.**
   `MEMORY_LONG_TERM_BYTE_BUDGET` (32 KiB) is the **write-time** working-set budget: `fn_memory_append`
   reports against it and `reconcile-long-term-memory-budget` consolidates against it. `MAX_MEMORY_LENGTH`
   (50,000 characters, `packages/engine/src/agents/agent-instructions.ts`) is the **injection-time** clamp
   that decides what actually enters a prompt. Neither implies the other: a file can sit under budget and
   still be clamped, and "over budget" must never be read as "everything is in the prompt". The clamp is
   measured in **characters**, not bytes, so multi-byte memory costs more context than the number suggests.
   Since RUFU-443 the full-render clamp is order-aware — it keeps the file preamble plus the **newest**
   `## ` sections that fit (a heading-less input keeps its tail, never its head, because `fn_memory_append`
   writes at the end) — and every omission is announced inside the rendered `## Agent Memory` section with
   the omitted section and character counts plus the `fn_memory_search` / `fn_memory_get` retrieval path.
   Loss was previously visible only as a server-side `log.warn`, so an agent could not tell that the
   lessons it had just written were absent from its own context.
   A **third**, session-level number (`memoryCapChars`, `CHAT_MEMORY_CAP_CHARS` = 8,000 chars on the chat
   path) keeps its existing self-announcing bounded-index contract. RUFU-443 changed no constant: 50,000
   characters is roughly 14K tokens, which is what a 64K-context chat model can afford inline
   (`FNXC:ChatContextBudget 2026-08-20-11:56`).

---

## 2. OpenClaw Research Findings

Fusion adopted OpenClaw-style layered memory while keeping a concrete TypeScript runtime contract.

### 2.1 What Was Adopted

- Layered workspace (`MEMORY.md`, daily files, `DREAMS.md`)
- Backend abstraction with explicit capability declarations
- Search over layered files with bounded snippets
- Migration safety via strict canonical path validation for layered files

### 2.2 Implications Table

| OpenClaw Concept | Fusion Current State | Contract Implication |
|---|---|---|
| Layered memory files | Implemented under `.fusion/memory/` | Canonical source-of-truth is workspace-based, not single-file |
| Path abstraction | Implemented via backend methods that receive `rootDir` (`read(rootDir)`, `write(rootDir, ...)`, etc.) | Backends must resolve paths relative to project root; no global hardcoded absolute paths |
| Pluggable backends | Implemented (`file`, `qmd`, `readonly`, custom) | Contract must document `MemoryBackend` exactly as shipped |
| Capability negotiation | Implemented via boolean-struct `capabilities` | No enum or lifecycle-based capability API |
| Search | Implemented through optional `search(rootDir, options)` hooks | Results are bounded snippets, not full-document dumps |
| Path migration completion | Legacy top-level path support removed from runtime APIs | Canonical source-of-truth is `.fusion/memory/` only |

---

## 3. Fusion Memory Plugin Contract

### 3.1 Runtime Interface (Canonical)

```ts
export interface MemoryBackendCapabilities {
  readable: boolean;
  writable: boolean;
  supportsAtomicWrite: boolean;
  hasConflictResolution: boolean;
  persistent: boolean;
}

export interface MemoryBackend {
  readonly type: string;
  readonly name: string;
  readonly capabilities: MemoryBackendCapabilities;
  read(rootDir: string): Promise<MemoryReadResult>;
  write(rootDir: string, content: string): Promise<MemoryWriteResult>;
  get?(rootDir: string, options: MemoryGetOptions): Promise<MemoryGetResult>;
  search?(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]>;
  exists?(rootDir: string): Promise<boolean>;
}

export interface MemoryBackendConfig {
  type: string;
  options?: Record<string, unknown>;
}
```

This is the active contract. The following are **not** part of current runtime semantics: `initialize()`, `hasCapability()`, `flush()`, `shutdown()`, class-based registry APIs, or lifecycle interfaces.

### 3.2 Error Contract

```ts
export type MemoryBackendErrorCode =
  | "NOT_FOUND"
  | "READ_ONLY"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "UNSUPPORTED"
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "BACKEND_UNAVAILABLE";

export class MemoryBackendError extends Error {
  readonly code: MemoryBackendErrorCode;
  readonly backend: string;
}
```

### 3.3 Built-In Backends

| Backend Class | Type | Current Behavior |
|---|---|---|
| `FileMemoryBackend` | `file` | Reads/writes canonical `.fusion/memory/MEMORY.md`; supports `exists/get/search`; atomic writes via temp file rename |
| `QmdMemoryBackend` | `qmd` | Delegates read/write to file backend; schedules qmd refresh; uses qmd search first, local layered search fallback |
| `ReadOnlyMemoryBackend` | `readonly` | Read-only; `write()` throws `MemoryBackendError("READ_ONLY", ...)`; `search()` returns empty |
| `StashMemoryBackend` | `stash` | Read/search/write via the Stash REST API (Bearer auth, injectable transport seam); keyword scoring per §3.3.2; opt-in vector search per §3.3.1 |

#### 3.3.1 Stash vector/semantic search (RUFU-126)

`StashMemoryBackend` supports an **opt-in vector (semantic) recall path** for
multi-word queries, layered in front of the RUFU-121 keyword path. Decision
provenance D1–D5: `docs/research/stash-vector-search-evaluation.md`.

**Endpoint contract.** `GET /api/v1/me/sessions/events/semantic-search` with
`q=<raw trimmed query, capped at 200 chars>` (NOT RUFU-121-normalized — the
embedder tokenizes on its own) and `limit=<same 1..20 clamp as the keyword
path>`. Response: the standard `HistoryEventListResponse` envelope
(`{ events: [...], has_more }`); each event carries `id`, `session_id`,
`content`/`snippet`, and a `rank` (cosine similarity, 0..1) from Stash.

**Flag (default off).** Per-project `stashVectorSearch` boolean, schema-only
(no UI row, consistent with `stashUrl`/`stashApiKey`), default `false`. Threaded
through `resolveMemoryBackend` into the materialized backend; the shared
registry default instance always stays off. Default-off = zero behavior
change until an operator enables it.

**Multi-word-only rule (D2).** The vector attempt runs only when the flag is
on AND the trimmed raw query has ≥2 whitespace-separated tokens. Single-word
queries stay keyword-only (exact-token FTS is the best single-token baseline).

**Fallback + negative-cache semantics.** On ANY vector failure — network
error/timeout, non-2xx, malformed body, or an empty vector result list —
`search()` falls through to the RUFU-121 keyword path **byte-identical**
(normalized `q`, legacy empty-query URL, limit cap, fail-closed `[]`). A
per-process negative capability cache (baseUrl-keyed, TTL 1h, test seam
`__resetVectorCapabilityCacheForTests`) suppresses further vector attempts
only after *definitive* no-vector responses — 404 (unpatched server), 405,
501, 503 (embedder unconfigured); 422/500 and network errors are never
cached, so the vector path retries on the next call.

**Score-scale caveat (D5).** Vector `score` = response `rank` (cosine
similarity, 0..1; missing/non-finite → 1.0). The keyword path no longer
keeps positional scores when the server supplies rank/score: it maps to a
comparable 0..1 scale (see §3.3.2), so keyword and vector hits share one
scale and the RUFU-120 single-threshold min-score filter can rank both.
The residual scale difference is the positional fallback (2.0 first hit,
1.0 thereafter) only — exercised by undeployed servers that supply neither
field.

**Upstream dependency.** The endpoint ships in a local Stash branch
(`fusion-rufu-126-sessions-semantic-search`, plus `sentence-transformers` in
requirements and a history-event embedding backfill task) — **not yet merged
or deployed**. Against an unpatched server the vector path 404s and falls
back transparently (once negatively cached per process). Operator rollout
steps (image rebuild with the embedder, backfill, verification, flag
enablement) are checklist form in
`docs/research/stash-vector-search-evaluation.md`.

#### 3.3.2 Stash keyword-search scoring (RUFU-133)

`StashMemoryBackend.search` maps every keyword hit to a **comparable 0..1
relevance score** — the D5 companion to the §3.3.1 vector path, so the
RUFU-120 client-side min-score filter can rank weak keyword hits against
weak vector hits (cosine similarity, 0..1) with one threshold.

**Three-tier mapping.** Per hit, in precedence order:

1. **Server score** — the response item's `score` field when present and
   usable (finite number, or a numeric string), clamped into [0,1]. A
   server score beats `rank` on the same item.
2. **Rank normalized** — otherwise the raw FTS `rank` (Stash `ts_rank`)
   divided by the max usable rank across the WHOLE result set (top hit =
   exactly 1.0; ts_rank is only meaningful relative to the result set),
   clamped into [0,1].
3. **Positional fallback** — otherwise the pre-RUFU-133 positional scores
   (2.0 first hit, 1.0 thereafter), for servers that supply neither field.

`maxRank == 0` (all ranks zero or missing) forces tier 3 with no
divide-by-zero; out-of-range values are clamped into [0,1] at every tier.

**Undeployed server shape is byte-identical.** Until the score field ships
in a deployed Stash image, responses carry neither `rank` nor `score` and
tier 3 applies — behavior is byte-identical to the pre-RUFU-133 positional
mapping (pinned by the RUFU-121 URL-contract and RUFU-133 test blocks in
`packages/core/src/memory/__tests__/memory-backend-stash.test.ts`).

**Upstream dependency.** The additive `score` field (normalized ts_rank,
response-model-only — no DB column, no migration) ships on the local Stash
branch `fusion-rufu-133-keyword-score` — **not yet merged or deployed**
(handoff note: RUFU-133 task doc `stash-handoff`). Once an image built from
that branch is deployed, `search()` automatically uses tiers 1/2 — no
Fusion change required.

### 3.4 Registry Contract (Function-Based)

```ts
registerMemoryBackend(backend: MemoryBackend): void
getMemoryBackend(type: string): MemoryBackend | undefined
listMemoryBackendTypes(): string[]
```

Backends are stored in a module-level `Map<string, MemoryBackend>`. Built-ins are registered at module load.

### 3.5 Resolution Contract

```ts
export const MEMORY_BACKEND_SETTINGS_KEYS = {
  MEMORY_BACKEND_TYPE: "memoryBackendType",
} as const;

export const DEFAULT_MEMORY_BACKEND = "qmd";

export function resolveMemoryBackend(settings?: { memoryBackendType?: string }): MemoryBackend
```

Resolution chain:
1. Configured `memoryBackendType` (if registered)
2. `DEFAULT_MEMORY_BACKEND` (`"qmd"`)

### 3.6 Layered Memory Operations

The layered memory workspace helpers in `memory-backend.ts` provide:

- Workspace bootstrap: `ensureOpenClawMemoryFiles()`
- File listing: `listProjectMemoryFiles()`
- Validated file access: `readProjectMemoryFile()`, `writeProjectMemoryFile()`
- Path helpers: `memoryLongTermPath()`, `dailyMemoryPath()`, `memoryDreamsPath()`

Allowed workspace files are constrained to:

- `.fusion/memory/MEMORY.md`
- `.fusion/memory/DREAMS.md`
- `.fusion/memory/YYYY-MM-DD.md`

### 3.7 Prompt Instruction Context Contract

`resolveMemoryInstructionContext(settings?)` in `project-memory.ts` currently resolves as:

| Condition | `backendType` | `instructionPathHint` | Behavior |
|---|---|---|---|
| `memoryEnabled === false` | `disabled` | `null` | No memory instructions |
| `memoryBackendType === "file"` | `file` | `.fusion/memory/MEMORY.md` | Explicit path-aware read/write instructions |
| `memoryBackendType === "readonly"` | `readonly` | `null` | Read-only instruction set |
| `memoryBackendType === "qmd"` or unknown | `qmd` | `null` | Backend-aware generic instructions |

### 3.8 File Compatibility & Source-of-Truth Semantics

#### 3.8.1 Canonical source-of-truth

- Canonical layered workspace: `.fusion/memory/`
- Canonical long-term file: `.fusion/memory/MEMORY.md`
- Runtime path validation rejects non-layered legacy requests

#### 3.8.2 QMD stale-index normalization scope

QMD search result normalization may remap stale indexed paths to canonical layered paths so search results remain consumable. This normalization does not re-enable legacy read/write APIs.

#### 3.8.3 Dashboard and API path constraints

Dashboard memory routes must remain rooted in project-scoped memory APIs:

- `/api/memory` uses backend-aware read/write (`readMemory`, `writeMemory`)
- `/api/memory/file` uses validated layered file operations (`MEMORY.md`, `DREAMS.md`, daily files)
- Read-only backends must reject writes with `READ_ONLY`

#### 3.8.4 Prompt compatibility matrix

| Backend | Read behavior | Write behavior | Instruction style |
|---|---|---|---|
| `qmd` (default) | Delegated file read | Delegated file write + qmd refresh schedule | Generic backend-aware instructions, no fixed path hint |
| `file` | Direct canonical file read | Direct canonical file write | Explicit `.fusion/memory/MEMORY.md` path hint |
| `readonly` | Empty/non-throw read semantics | Throws `READ_ONLY` | Read-only instructions only |

#### 3.8.5 Insight extraction relationship

Insight extraction is a separate subsystem that currently uses:

- Working source: `.fusion/memory/MEMORY.md`
- Insight output: `.fusion/memory/memory-insights.md`
- Audit output: `.fusion/memory/memory-audit.md`

It is related to, but not equivalent to, backend selection and prompt instruction logic.

---

## 4. Migration Strategy + Compatibility Guardrails

### 4.1 Migration Phase Status

| Phase | Task(s) | Status |
|---|---|---|
| Core backend contract + built-ins | FN-1418 | Complete |
| Engine backend-aware prompt integration | FN-1419 | Complete |
| Dashboard backend-aware memory integration | FN-1420 | Complete |
| Path/backend reconciliation umbrella | FN-2087 | Complete |
| Reconciliation implementation slices | FN-2131, FN-2132, FN-2133, FN-2134 | Complete |

### 4.2 Must-Not-Break Invariants

1. Canonical long-term layered memory remains `.fusion/memory/MEMORY.md`.
2. Legacy top-level memory requests are not part of the runtime API contract.
3. Runtime backend selection remains keyed by `memoryBackendType`.
4. `DEFAULT_MEMORY_BACKEND` remains `"qmd"` unless explicitly changed in code + docs.
5. Prompt instruction behavior remains backend-dependent via `resolveMemoryInstructionContext()`.
6. Missing working-memory reads degrade gracefully to empty string where contract requires.

### 4.3 Resolution Fallback Chain

1. Use configured backend type if registered.
2. Otherwise fall back to `DEFAULT_MEMORY_BACKEND` (`"qmd"`).
3. For `qmd` search failures/unavailability, fall back to local layered file search.

### 4.4 Compatibility Matrix

| Concern | Required Behavior |
|---|---|
| Settings persistence | Unknown `memoryBackendType` may be persisted, but runtime still falls back safely |
| Read-only backend | Writes fail with typed `READ_ONLY` error |
| Legacy upgrades | Runtime memory APIs ignore legacy top-level paths and operate on layered files only |
| Memory file APIs | Must enforce workspace-relative path validation and project root boundaries |
| Prompt generation | Must honor `memoryEnabled` toggle and backend-aware instruction context |

### 4.5 Test Coverage Verification Checklist

Contract-critical behavior is covered by:

- `packages/core/src/memory-backend.test.ts`
  - built-in backends (`file`, `qmd`, `readonly`)
  - registry helpers and `resolveMemoryBackend()` default/fallback behavior
  - layered workspace helpers (`ensureOpenClawMemoryFiles`, list/get/write, path validation)
- `packages/core/src/project-memory.test.ts`
  - canonical long-term path bootstrap/read behavior
  - `resolveMemoryInstructionContext()` branching
  - planning/execution/reviewer instruction generation per backend
- `packages/core/src/store.test.ts`
  - memory bootstrap behavior when memory is enabled/disabled and toggled
- Engine planning and executor tests
  - memory instruction injection behavior by settings/backend

---

## 5. Downstream Task Alignment

This contract should remain aligned with:

- [Architecture](./architecture.md)
- [Contributing](./contributing.md)
- [Settings Reference](./settings-reference.md)
- [Docs README](./README.md)

If backend contract behavior changes in source, update these docs in the same change.

---

*Last updated: 2026-04-19*

## Recall layer

The project-scoped recall store records durable `decision`, `preference`, and `solution` entries with content, tags, source provenance (`taskId`, `agentId`, `sessionId`, and origin), timestamps, and optional knowledge-graph node ids. `appendRecall` normalizes content (trim/lowercase/whitespace collapse/trailing punctuation removal) and rejects an exact normalized hash or Jaccard token similarity of at least `0.9` among the 200 most-recent same-kind records. That candidate window is intentionally bounded: an older exact twin is not visible to the in-memory classifier.

Writes hold a transaction advisory lock keyed by `(project, kind)` across candidate lookup and insert, which serializes the read-then-write near-duplicate decision without contending unrelated kinds or projects. The named `(project_id, kind, content_hash)` constraint is only an exact-hash backstop: `ON CONFLICT DO NOTHING` keeps the transaction usable for its in-transaction re-read when an exact twin is outside the bounded window (or a bypassing importer races the write). A raising unique insert would abort the transaction, and the constraint cannot catch near duplicates.

`searchRecall` uses deterministic keyword scoring and one shared `clampRecallSearchLimit` (default 10, maximum 50) for keyword, vector, degradation, and list paths. A caller may supply a per-call `RecallVectorSearchProvider` to rank—never fetch, write, or filter—the already project-scoped, kind/tag-filtered candidate set. There is no provider registry, setting, default implementation, or embedding dependency. `mode: "vector"` is returned only for a successful provider result containing a resolvable candidate; missing, throwing, empty, or unknown-only providers degrade to keyword mode while `capabilities.vector` remains true when a provider was supplied. Provider limits are advisory: the store discards unknown ids, keeps each duplicate id's highest score, ranks, then applies the same clamped limit after ranking.

Prompt builders may append a `### Recalled Context` section capped at 800 UTF-8 bytes; the budget includes its separator, heading, lines, and trailing newline, and never truncates pre-existing instructions. This task adds no MCP/tool surface, automatic capture, consolidation, agent pre-steering, or knowledge-graph integration; those remain later work.
