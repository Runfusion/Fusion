# Fusion Memory Plugin Contract

[← Docs index](./README.md)

This document defines the pluggable memory backend contract for Fusion, translating memory concepts into concrete interfaces that enable alternative storage backends while preserving all existing behavior.

---

## Table of Contents

1. [Current Fusion Memory Baseline](#1-current-fusion-memory-baseline)
2. [OpenClaw Research Findings](#2-openclaw-research-findings)
3. [Fusion Memory Plugin Contract](#3-fusion-memory-plugin-contract)
4. [Migration Strategy + Compatibility Guardrails](#4-migration-strategy--compatibility-guardrails)
5. [Downstream Task Alignment](#5-downstream-task-alignment)

---

## 1. Current Fusion Memory Baseline

### 1.1 Core Memory Modules

| Module | File | Responsibility |
|--------|------|----------------|
| `memory-backend.ts` | `packages/core/src/memory-backend.ts` | Canonical backend contract, built-in backends (`file`, `readonly`, `qmd`), backend registry/resolution, and file/get/search helpers |
| `project-memory.ts` | `packages/core/src/project-memory.ts` | Bootstrap, prompt instruction builders, backend-aware read/search/get wrappers, `resolveMemoryInstructionContext()` |
| `memory-insights.ts` | `packages/core/src/memory-insights.ts` | Scheduled insight extraction, merging, pruning validation/application, memory audit reporting |

#### Exported constants (current code)

| Constant | Value | Source |
|----------|-------|--------|
| `MEMORY_WORKSPACE_PATH` | `.fusion/memory` | `memory-backend.ts` |
| `MEMORY_LONG_TERM_FILENAME` | `MEMORY.md` | `memory-backend.ts` |
| `MEMORY_DREAMS_FILENAME` | `DREAMS.md` | `memory-backend.ts` |
| `LEGACY_MEMORY_FILE_PATH` | `.fusion/memory.md` | `memory-backend.ts` |
| `DEFAULT_MEMORY_BACKEND` | `qmd` | `memory-backend.ts` |
| `MEMORY_FILE_PATH` | `.fusion/memory/MEMORY.md` | `project-memory.ts` |
| `MEMORY_WORKING_PATH` | `.fusion/memory/MEMORY.md` | `memory-insights.ts` |
| `MEMORY_INSIGHTS_PATH` | `.fusion/memory-insights.md` | `memory-insights.ts` |
| `MEMORY_AUDIT_PATH` | `.fusion/memory-audit.md` | `memory-insights.ts` |

#### Key runtime interfaces/signatures (current code)

```typescript
// memory-backend.ts
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

export function resolveMemoryBackend(settings?: { memoryBackendType?: string }): MemoryBackend;

// project-memory.ts
export function resolveMemoryInstructionContext(settings?: { memoryEnabled?: boolean; memoryBackendType?: string }): MemoryInstructionContext;
export function buildTriageMemoryInstructions(rootDir: string, settings?: { memoryEnabled?: boolean; memoryBackendType?: string }): string;
export function buildExecutionMemoryInstructions(rootDir: string, settings?: { memoryEnabled?: boolean; memoryBackendType?: string }): string;
export function buildReviewerMemoryInstructions(rootDir: string, settings?: { memoryEnabled?: boolean; memoryBackendType?: string }): string;
```

### 1.2 Settings

**Files:**
- `packages/core/src/types.ts` (`ProjectSettings` fields)
- `packages/core/src/settings-schema.ts` (defaults)

```typescript
interface ProjectSettings {
  memoryEnabled?: boolean;                 // default true
  memoryBackendType?: string;              // default "qmd"
  insightExtractionEnabled?: boolean;      // default false
  insightExtractionSchedule?: string;      // default "0 2 * * *"
  insightExtractionMinIntervalMs?: number; // default 86400000
}
```

**Current defaults:**
- `memoryEnabled`: `true`
- `memoryBackendType`: `"qmd"`
- `insightExtractionEnabled`: `false`
- `insightExtractionSchedule`: `"0 2 * * *"`
- `insightExtractionMinIntervalMs`: `86400000`

### 1.3 Store Bootstrap + Toggle Behavior

**File:** `packages/core/src/store.ts`

- On store init, when `memoryEnabled !== false`, the store calls backend-aware memory bootstrap (`ensureMemoryFileWithBackend(this.rootDir, mergedSettings)`).
- On settings updates, when memory toggles from disabled → enabled, bootstrap is triggered again (idempotent).
- Bootstrap failures are non-fatal (wrapped in try/catch and logged); startup/settings flows continue.

### 1.4 Engine Prompt Wiring

- Triage (`packages/engine/src/triage.ts`) appends `buildTriageMemoryInstructions(...)` when `memoryEnabled !== false`.
- Executor (`packages/engine/src/executor.ts`) appends `buildExecutionMemoryInstructions(...)` when `memoryEnabled !== false`.
- Reviewer prompt builders use `buildReviewerMemoryInstructions(...)` with the same backend-aware context branching.

Prompt wording is selected by `resolveMemoryInstructionContext(settings?)`:
- `file` backend → explicit path hint (`.fusion/memory/MEMORY.md`)
- `qmd` backend (default) → no file-path hardcoding in instructions
- `readonly` backend → read-only instruction set

### 1.5 Dashboard Routes

**File:** `packages/dashboard/src/routes.ts`

| Route | Method | Description |
|-------|--------|-------------|
| `/api/memory` | GET | Returns `{ content: string }` from project memory (empty string if absent) |
| `/api/memory` | PUT | Body `{ content: string }`; writes memory content |

Route handlers are still file-service based, but operate on OpenClaw-style canonical long-term memory path (`.fusion/memory/MEMORY.md`) with migration compatibility for legacy `.fusion/memory.md` seeding/alias handling.

### 1.6 Dashboard Settings UI

**File:** `packages/dashboard/app/components/SettingsModal.tsx`

- Exposes `memoryEnabled` toggle
- Exposes `memoryBackendType` selection for available backends
- Loads/saves memory content via `/api/memory`
- Reflects memory-disabled state in editor controls

### 1.7 Existing Tests

| Test File | Coverage |
|-----------|----------|
| `packages/core/src/memory-backend.test.ts` | Backend interface behavior, built-in backends, registry helpers, layered path helpers/bootstrap (`ensureOpenClawMemoryFiles`), `DEFAULT_MEMORY_BACKEND = "qmd"`, backend resolution/fallback |
| `packages/core/src/project-memory.test.ts` | `MEMORY_FILE_PATH`, bootstrap behavior, backend-aware instruction context and prompt content |
| `packages/core/src/store.test.ts` | Init/toggle bootstrap behavior for enabled/disabled memory states |
| `packages/engine/src/triage.test.ts` | `memoryEnabled` and `memoryBackendType` influence on triage prompt injection |
| `packages/engine/src/executor.test.ts` | `memoryEnabled` and `memoryBackendType` influence on executor prompt injection |
| `packages/dashboard/app/components/SettingsModal.test.tsx` | Settings UI toggles for memory controls |

### 1.8 Summary of Non-Negotiable Behaviors

1. **Canonical layout**: OpenClaw-style memory workspace is canonical (`.fusion/memory/` with `MEMORY.md`, daily files, and `DREAMS.md`).
2. **Legacy compatibility**: Legacy `.fusion/memory.md` is a **deprecated legacy fallback** (migration seed / accepted alias), not canonical storage.
3. **Backend default**: Memory backend default is `qmd`.
4. **Backend selector key**: `memoryBackendType` controls backend selection.
5. **Toggle gate**: `memoryEnabled: false` disables memory prompt injection regardless of backend type.
6. **Bootstrap guarantees**: Memory bootstrap is idempotent and non-fatal; existing memory is not overwritten.
7. **Prompt context is backend-aware**: Instruction path hints and write directives vary by backend capabilities/type.

---

## 2. OpenClaw Research Findings

> **Provenance:** OpenClaw / pi-style memory patterns were used as design input. This section documents what Fusion adopted versus what remained conceptual.
>
> **Update (2026-04-19):** Fusion now uses a layered OpenClaw-style workspace as canonical storage:
> - `.fusion/memory/MEMORY.md` — curated long-term memory
> - `.fusion/memory/YYYY-MM-DD.md` — append-only daily notes
> - `.fusion/memory/DREAMS.md` — synthesized patterns
> - `.fusion/memory.md` — deprecated legacy fallback (migration compatibility only)

### 2.1 OpenClaw Memory Concepts

#### 2.1.1 Layered memory workspace

OpenClaw-style memory emphasizes a layered workspace rather than a single flat file. Fusion has adopted that model:

- Long-term memory: `.fusion/memory/MEMORY.md`
- Daily notes: `.fusion/memory/YYYY-MM-DD.md`
- Dream synthesis: `.fusion/memory/DREAMS.md`

Legacy `.fusion/memory.md` is retained only as a deprecated legacy fallback for migration compatibility.

#### 2.1.2 Pluggable backend abstraction

OpenClaw-style systems use backend abstraction so memory operations are not hardwired to one store. Fusion now implements this directly in `memory-backend.ts` with:

- `MemoryBackend` interface
- built-in backends (`file`, `readonly`, `qmd`)
- registry helpers and runtime resolution via settings

#### 2.1.3 Search over layered memory

OpenClaw-inspired retrieval patterns favor bounded snippets from multiple memory files. Fusion implements this with:

- backend `search?(rootDir, options)` hooks
- qmd-backed search (`QmdMemoryBackend`) when qmd is available
- local file-search fallback over the `.fusion/memory/` workspace

#### 2.1.4 Write behavior and durability

OpenClaw literature often discusses flush-style semantics; Fusion currently uses direct writes:

- `FileMemoryBackend` performs atomic file writes (temp file + rename)
- `QmdMemoryBackend` delegates writes to file backend, then schedules qmd refresh
- no explicit `flush()`/`shutdown()` lifecycle contract is currently required

### 2.2 Fusion Implications

| OpenClaw Concept | Fusion Current State | Contract Implication |
|-----------------|---------------------|----------------------|
| Layered memory files | Implemented (`MEMORY.md`, daily files, `DREAMS.md`) | Canonical path model is `.fusion/memory/` workspace, not a single flat file |
| Legacy compatibility | Retained only as a deprecated migration fallback/alias | Keep `.fusion/memory.md` references compatibility-scoped, not canonical |
| Pluggable backends | Implemented (registry + built-ins) | Contract must document real runtime API (`type`, `capabilities`, `read/write/get/search/exists`) |
| QMD backend | Implemented and default | Document `qmd` as default backend and describe qmd→local fallback behavior |
| Search capability | Implemented (`file` + `qmd`) | Contract search section must match real `search(rootDir, options)` signature and result shape |
| Backend resolution | Implemented via `memoryBackendType` | Contract/settings docs must use `memoryBackendType` and default `qmd` |

### 2.3 OpenClaw Memory Architecture Sources

1. OpenClaw/pi memory layout conventions (layered long-term + daily + synthesis files)
2. Existing Fusion implementation in `memory-backend.ts`, `project-memory.ts`, and `memory-insights.ts`
3. QMD integration pattern already shipped in Fusion (`QmdMemoryBackend`, qmd refresh/install helpers)

---

## 3. Fusion Memory Plugin Contract

### 3.1 Interface Definition

The canonical runtime contract lives in `packages/core/src/memory-backend.ts`.

```typescript
export interface MemoryBackendCapabilities {
  readable: boolean;
  writable: boolean;
  supportsAtomicWrite: boolean;
  hasConflictResolution: boolean;
  persistent: boolean;
}

export interface MemoryReadResult {
  content: string;
  exists: boolean;
  backend: string;
}

export interface MemoryWriteResult {
  success: boolean;
  backend: string;
}

export interface MemoryGetOptions {
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface MemoryGetResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  backend: string;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
}

export interface MemorySearchResult {
  path: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  score: number;
  backend: string;
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
  constructor(code: MemoryBackendErrorCode, message: string, backend: string);
}
```

**Important contract clarifications:**
- The backend identity field is `type` (not `id`).
- Capabilities are declared via `capabilities` object (no `hasCapability()` method).
- Backends are stateless from caller perspective; methods receive `rootDir` per call.
- The legacy `MemoryBackendConfig` type is still exported but is not the active runtime selection API.

### 3.2 Capability Negotiation

Fusion uses declarative capability flags on each backend instance:

| Capability | Meaning |
|-----------|---------|
| `readable` | Backend can return project memory content |
| `writable` | Backend accepts memory writes |
| `supportsAtomicWrite` | Backend can provide atomic update semantics |
| `hasConflictResolution` | Backend handles concurrent write conflicts internally |
| `persistent` | Data survives process/session restarts |

Call sites inspect `backend.capabilities` directly (for example, write paths reject non-writable backends).

### 3.3 Backend Registry

Current implementation is a module-level registry, not a class/factory API:

```typescript
const backendRegistry = new Map<string, MemoryBackend>();

registerMemoryBackend(backend: MemoryBackend): void
getMemoryBackend(type: string): MemoryBackend | undefined
listMemoryBackendTypes(): string[]
resolveMemoryBackend(settings?: { memoryBackendType?: string }): MemoryBackend
```

Built-ins are registered at module load:
- `file` → `FileMemoryBackend`
- `readonly` → `ReadOnlyMemoryBackend`
- `qmd` → `QmdMemoryBackend`

### 3.4 FileMemoryBackend

`FileMemoryBackend` is the filesystem implementation for the canonical long-term file.

- `type`: `file`
- `name`: `File (.fusion/memory/MEMORY.md)`
- Reads/writes: `.fusion/memory/MEMORY.md`
- Write behavior: atomic temp-file + rename
- Supports: `read`, `write`, `exists`, `get`, `search`

Legacy compatibility behavior tied to file backend ecosystem:
- Legacy `.fusion/memory.md` is retained as a deprecated compatibility constant (`LEGACY_MEMORY_FILE_PATH`)
- OpenClaw bootstrap (`ensureOpenClawMemoryFiles`) can seed `MEMORY.md` from legacy file on first migration
- `get` path normalization recognizes legacy alias paths, but canonical writes remain under `.fusion/memory/`

### 3.5 QmdMemoryBackend and Backend Resolution

`QmdMemoryBackend` is the default backend.

- `type`: `qmd`
- Delegates file read/write to `FileMemoryBackend`
- Schedules background qmd refresh on writes
- Uses qmd search first, then falls back to local layered-file search

Backend selection is resolved via settings key `memoryBackendType`:

```typescript
export const MEMORY_BACKEND_SETTINGS_KEYS = {
  MEMORY_BACKEND_TYPE: "memoryBackendType",
} as const;

export const DEFAULT_MEMORY_BACKEND = "qmd";

export function resolveMemoryBackend(settings?: { memoryBackendType?: string }): MemoryBackend {
  const backendType = settings?.memoryBackendType || DEFAULT_MEMORY_BACKEND;
  return backendRegistry.get(backendType) || backendRegistry.get(DEFAULT_MEMORY_BACKEND)!;
}
```

Resolution chain:
1. Explicit `memoryBackendType` if registered
2. Fallback to default backend (`qmd`)

### 3.6 Lifecycle Hooks

There is currently **no lifecycle hook contract** (`initialize`, `flush`, `shutdown`, `onInit`, etc.) in the shipped backend API.

Backends are long-lived instances registered in memory, and lifecycle concerns are handled externally by call sites and process lifecycle.

If lifecycle hooks are introduced later, they should be treated as future contract work (not current behavior).

### 3.7 Settings Extension

Current memory-related settings contract:

```typescript
interface ProjectSettings {
  memoryEnabled?: boolean;
  memoryBackendType?: string;   // file | readonly | qmd | custom
  insightExtractionEnabled?: boolean;
  insightExtractionSchedule?: string;
  insightExtractionMinIntervalMs?: number;
}
```

Notes:
- `memoryBackendType` is the active backend selector key.
- Legacy selector/config key names from pre-migration drafts are design artifacts and should not be documented as current settings APIs.
- Defaults are defined in `settings-schema.ts` (`memoryEnabled: true`, `memoryBackendType: "qmd"`).

### 3.8 File Compatibility & Source-of-Truth Semantics

#### 3.8.1 Canonical source-of-truth

- Canonical long-term memory path: `.fusion/memory/MEMORY.md`
- Canonical workspace root: `.fusion/memory/`
- Legacy `.fusion/memory.md` is a deprecated legacy fallback (migration/alias context)
- There is no persistent dual-write mirror contract in the current runtime API; migration compatibility is handled via bootstrap seeding and legacy path alias handling.

#### 3.8.2 Return-shape compatibility

| Function | Required behavior |
|----------|-------------------|
| `readProjectMemory(rootDir)` | Returns empty string (`""`) when long-term memory is absent |
| `readWorkingMemory(rootDir)` | Returns empty string (`""`) when working memory is absent |
| `readInsightsMemory(rootDir)` | Returns `null` when insights file is absent |
| `GET /api/memory` | Returns `{ content: string }`, using empty string when absent |

#### 3.8.3 File-service constraints

Dashboard file APIs and backend-aware helpers must remain project-scoped:
- Long-term memory writes target `.fusion/memory/MEMORY.md`
- Operations must stay inside project root boundary
- Text content is UTF-8 markdown

#### 3.8.4 Insights file handling

Insights storage remains file-based today:
- Working memory: `.fusion/memory/MEMORY.md`
- Insights: `.fusion/memory-insights.md`
- Audit: `.fusion/memory-audit.md`

#### 3.8.5 Prompt instruction compatibility

`resolveMemoryInstructionContext(settings?)` controls instruction shape:

| Backend Type | `instructionPathHint` | Instruction behavior |
|--------------|------------------------|----------------------|
| `file` | `.fusion/memory/MEMORY.md` | Explicit path-oriented read/write instructions |
| `qmd` (default) | `null` | Backend-aware generic instructions without hardcoded path |
| `readonly` | `null` | Read-only memory instructions (no write directives) |
| `disabled` (`memoryEnabled: false`) | `null` | No memory instructions injected |

#### 3.8.6 Must-not-break invariants

1. Memory remains accessible through OpenClaw canonical long-term path (`.fusion/memory/MEMORY.md`) in file-backed flows, and the built-in `file` backend remains available for explicit fallback/use.
2. Legacy `.fusion/memory.md` remains a deprecated legacy fallback and is not reintroduced as canonical storage.
3. Instruction behavior is backend-dependent; file backend can include path hints, qmd/readonly do not require one.
4. `memoryEnabled: false` suppresses memory prompt injection regardless of backend type.
5. Read semantics remain stable (`""` for missing working memory, `null` for missing insights memory).

#### 3.8.7 OpenClaw Layered Memory Layout

Canonical project memory uses a directory-based layout under `.fusion/memory/`:

| File | Purpose | Layer |
|------|---------|-------|
| `.fusion/memory/MEMORY.md` | Curated long-term memory (durable decisions, conventions, pitfalls) | long-term |
| `.fusion/memory/YYYY-MM-DD.md` | Append-only daily notes (running observations, open loops) | daily |
| `.fusion/memory/DREAMS.md` | Synthesized patterns/themes from daily notes | dreams |
| `.fusion/memory.md` | **Deprecated** legacy fallback (migration compatibility only) | legacy |

Migration behavior (`ensureOpenClawMemoryFiles()`):
- When `.fusion/memory/MEMORY.md` does not exist but `.fusion/memory.md` does, legacy content is seeded into the new canonical file
- Once `.fusion/memory/MEMORY.md` exists, canonical writes stay in `.fusion/memory/` (no legacy re-canonicalization)
- Legacy paths may still appear as accepted aliases during transition, but are not canonical storage

---
## 4. Migration Strategy + Compatibility Guardrails

### 4.1 Phased Migration Plan

The migration work has already progressed beyond the original FN-1418/FN-1419/FN-1420 plan.

| Phase | Task(s) | Status | Description |
|-------|---------|--------|-------------|
| 1 | FN-1418 | Complete | Core backend contract and built-ins landed in `@fusion/core` |
| 2 | FN-1419 | Complete | Engine prompt paths moved to backend-aware instruction generation |
| 3 | FN-1420 | Complete | Dashboard memory flows integrated with backend-aware memory model |
| 4 | FN-2087 | Active umbrella | Reconcile remaining migration edges and legacy-path consistency across runtime/docs/tests |
| 5 | FN-2131–FN-2134 | Active/queued implementation phases | Execute remaining migration slices under FN-2087 |

### 4.2 Compatibility Matrix

#### Settings

| Setting | Current behavior | Compatibility expectation |
|---------|------------------|---------------------------|
| `memoryEnabled` | Default `true` | Preserved |
| `memoryEnabled: false` | Suppresses memory prompt injection | Preserved |
| `memoryBackendType` | Default `"qmd"`; supports `file`, `readonly`, `qmd`, custom registered types | Preserved |
| Unknown `memoryBackendType` | Falls back to default backend (`qmd`) | Preserved |
| Insight extraction settings | `insightExtractionEnabled`, `insightExtractionSchedule`, `insightExtractionMinIntervalMs` | Preserved |

#### Paths and files

| Path | Role | Compatibility expectation |
|------|------|---------------------------|
| `.fusion/memory/MEMORY.md` | Canonical long-term working memory | Canonical |
| `.fusion/memory/YYYY-MM-DD.md` | Daily memory | Canonical layered layout |
| `.fusion/memory/DREAMS.md` | Dream/synthesis memory | Canonical layered layout |
| `.fusion/memory.md` | Deprecated legacy fallback path | Compatibility-only (migration/alias), not canonical |
| `.fusion/memory-insights.md` | Insight extraction output | Preserved |
| `.fusion/memory-audit.md` | Extraction audit output | Preserved |

#### Prompt behavior

| Condition | Expected behavior |
|-----------|-------------------|
| `memoryEnabled: true`, backend=`file` | Memory instructions include explicit `.fusion/memory/MEMORY.md` path hint |
| `memoryEnabled: true`, backend=`qmd` | Memory instructions are backend-aware and omit hardcoded file path |
| `memoryEnabled: true`, backend=`readonly` | Memory instructions are read-only (no update directives) |
| `memoryEnabled: false` | No memory instructions injected, regardless of backend |

### 4.3 Must-Not-Break Invariants

1. **Canonical layout invariant:** OpenClaw layered memory workspace (`.fusion/memory/`) remains canonical.
2. **Legacy-path invariant:** `.fusion/memory.md` remains a deprecated legacy fallback; it must not be reintroduced as primary storage.
3. **Backend-selection invariant:** Runtime selection uses `memoryBackendType`, with default `qmd`.
4. **Prompt-context invariant:** Memory instructions vary by backend type; only `file` backend emits an explicit file path hint.
5. **Read-shape invariant:** Missing working memory resolves to `""`; missing insights memory resolves to `null`.
6. **Non-fatal invariant:** Bootstrap and memory-operation failures should not block store startup/settings updates.

### 4.4 Fallback Trigger Conditions

| Condition | Action |
|-----------|--------|
| `memoryBackendType` missing | Use `DEFAULT_MEMORY_BACKEND` (`qmd`) |
| Configured backend type not registered | Fall back to `qmd` |
| QMD search unavailable/fails | Fall back to local layered-file search |
| Backend marked non-writable (`readonly`) | Reject writes with `MemoryBackendError("READ_ONLY", ...)` |
| Read failures marked as backend-unavailable/read-failed in helper wrappers | Return empty content shape where contract requires graceful degradation |

### 4.5 Test Coverage Verification Checklist

| Behavior | Test File | Lines |
|----------|-----------|-------|
| `DEFAULT_MEMORY_BACKEND === "qmd"` and settings key `memoryBackendType` | `packages/core/src/memory-backend.test.ts` | 720, 724 |
| `resolveMemoryBackend()` default + type-specific resolution/fallback | `packages/core/src/memory-backend.test.ts` | 730–756 |
| Canonical `MEMORY_FILE_PATH` value | `packages/core/src/project-memory.test.ts` | 41–43 |
| `resolveMemoryInstructionContext` backend-specific path hints | `packages/core/src/project-memory.test.ts` | 450–485 |
| Backend-aware triage instruction generation | `packages/core/src/project-memory.test.ts` | 493–546 |
| Backend-aware execution instruction generation | `packages/core/src/project-memory.test.ts` | 548–604 |
| Store init/toggle bootstrap behavior | `packages/core/src/store.test.ts` | 8254–8336 |
| Triage prompt memory enable/disable + backend branching | `packages/engine/src/triage.test.ts` | 272–323 |
| Executor prompt memory enable/disable + backend branching | `packages/engine/src/executor.test.ts` | 2413–2463 |

### 4.6 Cross-Linking

This specification must remain aligned with:
- [Architecture](./architecture.md) — memory subsystem + storage model
- [Contributing](./contributing.md) — memory file conventions for contributors/agents
- [Settings Reference](./settings-reference.md) — user-facing settings and insight extraction behavior
- [README](./README.md) — documentation index

Related migration tasks:
- FN-1418/FN-1419/FN-1420 — completed foundational migration
- FN-2087 — active migration reconciliation umbrella
- FN-2131/FN-2132/FN-2133/FN-2134 — migration execution phases

---

## 5. Downstream Task Alignment

### 5.1 Completed foundation (historical)

#### FN-1418 — Implement Core Memory Plugin Infrastructure (**Complete**)

Delivered:
- `MemoryBackend` runtime contract in `@fusion/core`
- Built-in backend implementations and registry helpers
- Backend resolution plumbing and tests

#### FN-1419 — Update Engine to Use Backend Abstraction (**Complete**)

Delivered:
- Backend-aware memory instruction wiring in engine prompt builders
- `memoryBackendType` settings integration in runtime selection path
- Regression coverage for `memoryEnabled` and backend branching

#### FN-1420 — Update Dashboard to Use Backend Abstraction (**Complete**)

Delivered:
- Dashboard memory routes/UI aligned with backend-aware memory model
- Memory settings controls and persistence behavior

### 5.2 Active migration reconciliation

#### FN-2087 — Memory path/backend reconciliation umbrella (**Active**)

Purpose:
- Finish migration cleanup and eliminate remaining legacy-path contradictions across runtime prompts, tests, and docs.

#### FN-2131–FN-2134 — Implementation slices under FN-2087 (**Active/queued**)

Purpose:
- Execute the remaining migration phases in scoped increments while preserving backward compatibility.

### 5.3 Documentation alignment requirement

This contract is the canonical documentation reference for memory backend semantics. Any future migration step that changes runtime behavior must update this file and keep `architecture.md`, `contributing.md`, and `settings-reference.md` in sync in the same change.

---
## Appendix A: Reference Implementation Notes

### A.1 Module Location

Current memory backend infrastructure lives in `@fusion/core`:

```
packages/core/src/
├── memory-backend.ts          # Interface, registry, built-in backends, path helpers
├── project-memory.ts          # Bootstrap + prompt instruction wiring
├── memory-insights.ts         # Insight extraction + pruning paths
└── index.ts                   # Re-export surface
```

### A.2 Test Strategy

| Test Type | Coverage |
|-----------|----------|
| Unit tests | Each backend class in isolation |
| Integration tests | Backend with real filesystem |
| Contract tests | All backends satisfy `MemoryBackend` interface |
| Compatibility tests | Ensure file backend matches current behavior exactly |

### A.3 Documentation Updates

After implementation or migration updates:
- Update [Settings Reference](./settings-reference.md) with `memoryBackendType` behavior and defaults
- Update [Architecture](./architecture.md) memory section with backend/runtime behavior changes
- Update AGENTS.md if engine prompt wiring changes

---

## Appendix B: Future Extensibility

### B.1 Vector/Semantic Search Backend

A future backend could implement semantic search:

```typescript
class VectorMemoryBackend implements MemoryBackend {
  readonly type = "vector";
  readonly name = "Vector Search";
  readonly capabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: true,
  };

  async read(rootDir: string): Promise<MemoryReadResult> {
    // delegate to file storage, then enrich vector index
  }

  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    // persist + reindex embeddings
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    // semantic query over embeddings
  }
}
```

### B.2 Hybrid Backend

A hybrid backend could combine file persistence with vector search:

```typescript
class HybridMemoryBackend implements MemoryBackend {
  readonly type = "hybrid";
  readonly name = "Hybrid File + Semantic Search";
  readonly capabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: true,
    hasConflictResolution: false,
    persistent: true,
  };

  private file = new FileMemoryBackend();
  private vector = new VectorMemoryBackend();

  async read(rootDir: string): Promise<MemoryReadResult> {
    return this.file.read(rootDir);
  }

  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    const result = await this.file.write(rootDir, content);
    await this.vector.write(rootDir, content);
    return { ...result, backend: this.type };
  }

  async search(rootDir: string, options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    // route by search mode, then fallback
  }
}
```

---

*Last updated: 2026-04-09*
