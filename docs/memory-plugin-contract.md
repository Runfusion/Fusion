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
| `MEMORY_INSIGHTS_PATH` | `.fusion/memory-insights.md` | `memory-insights.ts` |
| `MEMORY_AUDIT_PATH` | `.fusion/memory-audit.md` | `memory-insights.ts` |

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
| `buildTriageMemoryInstructions()` | Triage prompt memory instructions |
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
- Insight output: `.fusion/memory-insights.md`
- Audit output: `.fusion/memory-audit.md`

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
  - triage/execution/reviewer instruction generation per backend
- `packages/core/src/store.test.ts`
  - memory bootstrap behavior when memory is enabled/disabled and toggled
- `packages/engine/src/triage.test.ts` and `packages/engine/src/executor.test.ts`
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
