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
| `project-memory.ts` | `packages/core/src/project-memory.ts` | Bootstrap, scaffold, prompt instruction builders |
| `memory-insights.ts` | `packages/core/src/memory-insights.ts` | Two-stage memory system, insight extraction, automation |

#### `project-memory.ts` — Exports

```typescript
// Constants
MEMORY_FILE_PATH: ".fusion/memory.md"

// Functions
memoryFilePath(rootDir: string): string
getDefaultMemoryScaffold(): string          // Returns markdown scaffold with ## Architecture, ## Conventions, ## Pitfalls, ## Context
ensureMemoryFile(rootDir: string): Promise<boolean>  // Idempotent bootstrap; creates .fusion dir + file
buildTriageMemoryInstructions(rootDir: string): string   // Prompt section for spec agent
buildExecutionMemoryInstructions(rootDir: string): string // Prompt section for executor
readProjectMemory(rootDir: string): Promise<string>      // Read current content (empty string if absent)
```

**Key invariants:**
- `MEMORY_FILE_PATH` is always `.fusion/memory.md` (project-root relative, NOT worktree-local)
- `ensureMemoryFile` is idempotent: safe to call multiple times; never overwrites existing content
- Bootstrap failure is non-fatal: `store.ts` wraps the call in try/catch

#### `memory-insights.ts` — Two-Stage Memory System with Pruning

The module implements a two-tier memory architecture with automatic pruning:

1. **Working memory** (`memory.md`) — agent-maintained, manually edited, automatically pruned
2. **Insights memory** (`memory-insights.md`) — AI-extracted distilled knowledge

```typescript
// Constants
MEMORY_WORKING_PATH: ".fusion/memory.md"
MEMORY_INSIGHTS_PATH: ".fusion/memory-insights.md"
DEFAULT_INSIGHT_SCHEDULE: "0 2 * * *"           // Daily at 2 AM
DEFAULT_MIN_INTERVAL_MS: 86400000               // 24 hours
MIN_INSIGHT_GROWTH_CHARS: 1000                  // Growth threshold
INSIGHT_EXTRACTION_SCHEDULE_NAME: "Memory Insight Extraction"

// Functions
readWorkingMemory(rootDir: string): Promise<string>      // "" if absent
readInsightsMemory(rootDir: string): Promise<string|null> // null if absent
writeInsightsMemory(rootDir: string, content: string): void
writeWorkingMemory(rootDir: string, content: string): void
buildInsightExtractionPrompt(workingMemory: string, existingInsights: string|null): string
parseInsightExtractionResponse(response: string): InsightExtractionResult
mergeInsights(existing: string, newInsights: MemoryInsight[]): string
shouldTriggerExtraction(lastRun, settings, workingMemorySize, lastMemorySize): boolean
getDefaultInsightsTemplate(): string
createInsightExtractionAutomation(settings): ScheduledTaskCreateInput
syncInsightExtractionAutomation(automationStore, settings): ScheduledTask | undefined
validatePruneCandidate(candidate: string | undefined): PruneValidationResult
applyMemoryPruning(rootDir: string, pruneCandidate: string | undefined): Promise<PruneOutcome>
processInsightExtractionRun(rootDir: string, input: ProcessRunInput): Promise<Result>
processAndAuditInsightExtraction(rootDir: string, input: ProcessRunInput): Promise<MemoryAuditReport>

// Types
MemoryInsightCategory: "pattern" | "principle" | "convention" | "pitfall" | "context"
MemoryInsight: { category, content, source?, extractedAt }
InsightExtractionResult: { insights: MemoryInsight[], summary, extractedAt, prunedMemory?: string }
PruneValidationResult: { valid: boolean, reason?: string, size: number, hasRequiredSections: boolean }
PruneOutcome: { applied: boolean, reason: string, sizeDelta: number, originalSize: number, newSize: number }
MemoryAuditReport: { ..., pruning: { applied: boolean, reason: string, sizeDelta: number, ... } }
```

**Pruning behavior (FN-1477):**
- AI response may include `prunedMemory` field with a pruned working memory candidate
- `validatePruneCandidate()` checks that at least 2 of 3 required sections are preserved (Architecture, Conventions, Pitfalls)
- `applyMemoryPruning()` only writes to `.fusion/memory.md` if validation passes
- Invalid prune candidates are safely ignored; existing memory is preserved
- Pruning outcome is included in audit reports for operator visibility

### 1.2 Settings

**File:** `packages/core/src/types.ts`

```typescript
// ProjectSettings interface (partial)
interface ProjectSettings {
  // ... other fields ...

  /** When true, agents will consult and update .fusion/memory.md.
   *  Default: true (enabled for backward compatibility). */
  memoryEnabled?: boolean;

  /** When true, enables periodic AI-powered extraction of insights. Default: false. */
  insightExtractionEnabled?: boolean;

  /** Cron expression for insight extraction. Default: "0 2 * * *". */
  insightExtractionSchedule?: string;

  /** Minimum interval between extractions in ms. Default: 86400000 (24h). */
  insightExtractionMinIntervalMs?: number;
}
```

**Defaults (from `DEFAULT_PROJECT_SETTINGS`):**
- `memoryEnabled`: `true`
- `insightExtractionEnabled`: `false`
- `insightExtractionSchedule`: `"0 2 * * *"`
- `insightExtractionMinIntervalMs`: `86400000`

**Null-as-delete semantics:** `updateSettings({ memoryEnabled: null })` clears the key from `config.json`, falling back to the default (`true`).

### 1.3 Store Bootstrap + Toggle Behavior

**File:** `packages/core/src/store.ts`

```typescript
// init() — idempotent bootstrap
await ensureMemoryFile(this.rootDir);  // guarded by memoryEnabled !== false

// updateSettings() — toggle-on creates file
if (updatedMerged.memoryEnabled !== false && previousMerged.memoryEnabled === false) {
  await ensureMemoryFile(this.rootDir);  // non-fatal
}
```

### 1.4 Engine Prompt Wiring

#### Triage (`packages/engine/src/triage.ts`, line ~1386)

```typescript
const memoryEnabled = settings?.memoryEnabled !== false;  // default: true
if (memoryEnabled) {
  memorySection = "\n\n" + buildTriageMemoryInstructions("");
  prompt += memorySection;
}
```

#### Executor (`packages/engine/src/executor.ts`, line ~3285)

```typescript
const memoryEnabled = settings?.memoryEnabled !== false;  // default: true
if (memoryEnabled && rootDir) {
  memorySection = "\n" + buildExecutionMemoryInstructions(rootDir);
  // Injects read-at-start + append-at-end instructions
}
```

### 1.5 Dashboard Routes

**File:** `packages/dashboard/src/routes.ts` (lines 1605–1645)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/memory` | GET | Returns `{ content: string }` — empty string if file absent |
| `/api/memory` | PUT | Body: `{ content: string }` — writes to `.fusion/memory.md` |

Both routes use `readProjectFile` / `writeProjectFile` from `file-service.ts`, which enforces project-root path constraints (memory path is `.fusion/memory.md` — always within project scope).

### 1.6 Dashboard Settings UI

**File:** `packages/dashboard/app/components/SettingsModal.tsx` (lines ~1528–1590)

- Toggle `memoryEnabled` with checkbox
- Conditional rendering: when `memoryEnabled === false`, memory editor is read-only with informational message
- Loads memory content via `GET /api/memory` on section activation
- Saves via `PUT /api/memory` with dirty-tracking

### 1.7 Existing Tests

| Test File | Coverage |
|-----------|----------|
| `packages/core/src/project-memory.test.ts` | `MEMORY_FILE_PATH`, scaffold headings, idempotent bootstrap, prompt instruction content |
| `packages/core/src/store.test.ts` (line 6010+) | Bootstrap on init, toggle behavior, no-overwrite guarantee |
| `packages/engine/src/triage.test.ts` (line 227+) | `memoryEnabled: true` → instructions included; `false` → excluded; undefined → default |
| `packages/engine/src/executor.test.ts` (line 2175+) | Same as triage, plus append instruction, project-root path |

### 1.8 Summary of Non-Negotiable Behaviors

1. **File path**: Memory always lives at `.fusion/memory.md` (project root, not worktree)
2. **Toggle**: `memoryEnabled` controls all memory behavior — when `false`, no instructions injected, no reads/writes
3. **Default**: `memoryEnabled: true` (backward-compatible default)
4. **Idempotent bootstrap**: `ensureMemoryFile` never overwrites existing content
5. **Non-fatal setup**: memory initialization failures do not block startup or settings updates
6. **Prompt injection**: memory instructions are appended to existing prompt sections (not replacing core prompts)

---

## 2. OpenClaw Research Findings

> **Provenance:** Analysis of OpenClaw's memory architecture as implemented in the pi-coding-agent framework (referenced in `node_modules/@mariozechner/pi-coding-agent/README.md`) and patterns observed in agent memory literature.

### 2.1 OpenClaw Memory Concepts

OpenClaw (and the broader pi ecosystem) implement a plugin-based memory architecture with the following concepts:

#### 2.1.1 Memory Backend Plugins

OpenClaw supports pluggable memory backends via a registry pattern:

```typescript
// Conceptual OpenClaw pattern
interface MemoryBackend {
  /** Backend identifier (e.g., "file", "sqlite", "vector") */
  readonly id: string;

  /** Initialize the backend with configuration */
  initialize(config: Record<string, unknown>): Promise<void>;

  /** Read memory content */
  read(): Promise<string>;

  /** Write memory content */
  write(content: string): Promise<void>;

  /** Search memory (optional capability) */
  search?(query: string): Promise<MemorySearchResult[]>;

  /** Flush/sync any pending writes */
  flush?(): Promise<void>;

  /** Shutdown the backend */
  shutdown(): Promise<void>;
}
```

#### 2.1.2 Memory File Management

OpenClaw's memory system includes:
- **Auto-flush**: Automatic write-through after agent session modifications
- **Flush triggers**: After each significant memory modification, or on session end
- **Path management**: Memory files stored relative to project root, not worktree-local

#### 2.1.3 Search Capabilities

Some OpenClaw backends support semantic or keyword search:
- File-based backends: grep-style text search
- Vector backends: semantic similarity search
- Hybrid: fallback from semantic to keyword search

#### 2.1.4 Fallback Behavior

OpenClaw backends fall back to a default (file-based) backend when:
- Requested backend is unavailable
- Backend initialization fails
- Backend lacks required capabilities

### 2.2 Fusion Implications

| OpenClaw Concept | Fusion Current State | Implication for Contract |
|-----------------|---------------------|--------------------------|
| Pluggable backends | Single file-based implementation | Need `MemoryBackend` interface + registry |
| Auto-flush | Manual writes via dashboard | Backend should handle internal buffering |
| Search capability | Not implemented | Optional `search()` method in interface |
| Fallback semantics | Always file-based | Need explicit fallback chain |
| Path abstraction | Hardcoded `.fusion/memory.md` | Backend config includes `rootDir` |

### 2.3 OpenClaw Memory Architecture Sources

1. **pi-coding-agent** (`node_modules/@mariozechner/pi-coding-agent/`) — SDK integration reference
2. **Agent memory frameworks** (Mastra, LangChain, MemGPT) — Pattern inspiration for two-stage memory
3. **QMD (Quantized Memory Distillation)** — Insight extraction and deduplication approach already used in `memory-insights.ts`

---

## 3. Fusion Memory Plugin Contract

### 3.1 Interface Definition

```typescript
/**
 * Memory backend plugin interface.
 * Implement this interface to provide alternative storage for project memory.
 */
export interface MemoryBackend {
  /** Backend identifier (e.g., "file", "sqlite", "vector"). */
  readonly id: string;

  /**
   * Backend display name for UI and diagnostics.
   */
  readonly name: string;

  /**
   * Backend version for compatibility checking.
   */
  readonly version: string;

  /**
   * Initialize the backend with project configuration.
   * Called once when the backend is first resolved/registered.
   *
   * @param config - Backend-specific configuration
   * @param rootDir - Absolute path to the project root directory
   */
  initialize(config: MemoryBackendConfig, rootDir: string): Promise<void>;

  /**
   * Check if the backend has a specific capability.
   *
   * @param capability - The capability to check
   * @returns true if the capability is supported, false otherwise
   */
  hasCapability(capability: MemoryCapability): boolean;

  /**
   * Read the current memory content.
   *
   * @returns The memory content as a string, or empty string if no content exists.
   * @throws MemoryBackendError if the read fails
   */
  read(): Promise<string>;

  /**
   * Write new memory content.
   * The backend may buffer writes and flush asynchronously.
   *
   * @param content - The new memory content to write
   * @throws MemoryBackendError if the write fails
   */
  write(content: string): Promise<void>;

  /**
   * Search memory content.
   * Only available if `hasCapability("search")` returns true.
   *
   * @param query - Search query string
   * @param options - Optional search options (limit, offset)
   * @returns Array of matching search results with context
   * @throws MemoryBackendError if search is not supported or fails
   */
  search?(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;

  /**
   * Flush any buffered writes to persistent storage.
   * Call this before shutdown or when explicit sync is needed.
   *
   * @throws MemoryBackendError if flush fails
   */
  flush?(): Promise<void>;

  /**
   * Shutdown the backend gracefully.
   * Should flush pending writes before closing.
   *
   * @throws MemoryBackendError if shutdown fails
   */
  shutdown(): Promise<void>;
}

/**
 * Backend-specific configuration passed during initialization.
 */
export interface MemoryBackendConfig {
  /** Backend identifier */
  id: string;
  /** Backend-specific key-value configuration */
  [key: string]: unknown;
}

/**
 * Memory backend capabilities that may be optionally supported.
 */
export type MemoryCapability =
  | "read"       // Basic read capability (always required)
  | "write"      // Basic write capability (always required)
  | "search"     // Full-text or semantic search
  | "insights"   // AI-powered insight extraction
  | "transactions"; // Atomic read-write transactions

/**
 * Search options for backends that support search.
 */
export interface MemorySearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
  /** Search mode: "keyword" or "semantic" */
  mode?: "keyword" | "semantic";
}

/**
 * A single search result from memory search.
 */
export interface MemorySearchResult {
  /** The matching content snippet */
  content: string;
  /** Relevance score (0-1, higher is better) */
  score: number;
  /** Section/heading containing the match */
  section?: string;
  /** Line number of the match (for file-based backends) */
  lineNumber?: number;
}

/**
 * Error class for memory backend operations.
 */
export class MemoryBackendError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly backendId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "MemoryBackendError";
  }
}
```

### 3.2 Capability Negotiation

```typescript
/**
 * Check if a backend supports a required capability.
 * Throws if the capability is not supported.
 */
export function requireCapability(
  backend: MemoryBackend,
  capability: MemoryCapability,
): void {
  if (!backend.hasCapability(capability)) {
    throw new MemoryBackendError(
      `Backend "${backend.id}" does not support required capability: ${capability}`,
      "CAPABILITY_UNSUPPORTED",
      backend.id,
    );
  }
}

/**
 * Get the effective capability set for a backend,
 * accounting for defaults and missing optional methods.
 */
export function getBackendCapabilities(backend: MemoryBackend): Set<MemoryCapability> {
  const capabilities = new Set<MemoryCapability>(["read", "write"]);

  if (typeof backend.search === "function") {
    capabilities.add("search");
  }
  if (typeof backend.flush === "function") {
    capabilities.add("transactions");
  }

  // Insights capability is determined by external service, not backend
  return capabilities;
}
```

### 3.3 Backend Registry

```typescript
/**
 * Memory backend registry for registering and resolving backends.
 */
export class MemoryBackendRegistry {
  private backends = new Map<string, MemoryBackendFactory>();

  /**
   * Register a new memory backend.
   *
   * @param factory - Factory function that creates backend instances
   */
  register(factory: MemoryBackendFactory): void;

  /**
   * Unregister a memory backend by ID.
   *
   * @param id - Backend identifier
   * @returns true if unregistered, false if not found
   */
  unregister(id: string): boolean;

  /**
   * Check if a backend is registered.
   *
   * @param id - Backend identifier
   */
  has(id: string): boolean;

  /**
   * Create a backend instance by ID.
   *
   * @param id - Backend identifier
   * @param config - Backend configuration
   * @param rootDir - Project root directory
   * @returns The created backend instance
   * @throws MemoryBackendError if backend not found or initialization fails
   */
  create(id: string, config: MemoryBackendConfig, rootDir: string): Promise<MemoryBackend>;

  /**
   * Get all registered backend IDs.
   */
  list(): string[];
}

/**
 * Factory function type for creating backend instances.
 */
export type MemoryBackendFactory = (
  config: MemoryBackendConfig,
) => MemoryBackend | Promise<MemoryBackend>;
```

### 3.4 Default File Backend

```typescript
/**
 * Default file-based memory backend.
 * Preserves exact current behavior: .fusion/memory.md on project root.
 *
 * This backend is always registered as the fallback when no other backend
 * is configured or when configured backend is unavailable.
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly id = "file";
  readonly name = "File System";
  readonly version = "1.0.0";

  private rootDir: string = "";
  private initialized = false;

  async initialize(config: MemoryBackendConfig, rootDir: string): Promise<void> {
    this.rootDir = rootDir;
    this.initialized = true;
  }

  hasCapability(capability: MemoryCapability): boolean {
    // File backend supports read/write, no search
    return capability === "read" || capability === "write";
  }

  async read(): Promise<string> {
    this.requireInitialized();
    return readProjectMemory(this.rootDir);  // Delegates to existing project-memory.ts
  }

  async write(content: string): Promise<void> {
    this.requireInitialized();
    const filePath = memoryFilePath(this.rootDir);
    const dir = join(this.rootDir, ".fusion");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  async flush(): Promise<void> {
    // File backend writes synchronously, nothing to flush
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new MemoryBackendError(
        "Backend not initialized. Call initialize() first.",
        "NOT_INITIALIZED",
        this.id,
      );
    }
  }
}
```

### 3.5 Backend Resolution

```typescript
/**
 * Resolve the active memory backend for a project.
 *
 * Resolution order:
 * 1. If `memoryBackend` is set in project settings, use that backend
 * 2. If `memoryBackend` is set but unavailable, fall back to "file" backend
 * 3. Default to "file" backend (preserves current behavior)
 *
 * @param settings - Project settings (may include memoryBackend config)
 * @param rootDir - Project root directory
 * @param registry - Backend registry to use for resolution
 * @returns The resolved backend instance
 */
export async function resolveMemoryBackend(
  settings: Partial<ProjectSettings>,
  rootDir: string,
  registry: MemoryBackendRegistry,
): Promise<MemoryBackend> {
  const configuredId = settings.memoryBackend ?? "file";

  try {
    const config = settings.memoryBackendConfig ?? {};
    return await registry.create(configuredId, { id: configuredId, ...config }, rootDir);
  } catch (error) {
    // Fall back to file backend on any resolution failure
    console.warn(
      `[MemoryBackend] Failed to resolve "${configuredId}", falling back to "file" backend:`,
      error instanceof Error ? error.message : String(error),
    );
    return await registry.create("file", { id: "file" }, rootDir);
  }
}
```

### 3.6 Lifecycle Hooks

```typescript
/**
 * Lifecycle hook interface for memory backends.
 * Backends may implement these for integration with Fusion's startup/shutdown.
 */
export interface MemoryBackendLifecycle {
  /**
   * Called when the project store initializes.
   * Use for setting up resources that require async initialization.
   */
  onInit?(): Promise<void>;

  /**
   * Called when settings are updated.
   * Use for responding to settings changes that affect memory behavior.
   */
  onSettingsUpdate?(previous: Partial<ProjectSettings>, current: Partial<ProjectSettings>): Promise<void>;

  /**
   * Called before the project store closes.
   * Use for graceful cleanup and flushing.
   */
  onClose?(): Promise<void>;
}

/**
 * Memory backend with lifecycle support.
 * Combines MemoryBackend with optional lifecycle hooks.
 */
export interface StatefulMemoryBackend extends MemoryBackend, Partial<MemoryBackendLifecycle> {}
```

### 3.7 Settings Extension

```typescript
// New fields to add to ProjectSettings in packages/core/src/types.ts

interface ProjectSettings {
  // ... existing fields ...

  /**
   * Memory backend identifier to use for this project.
   * When undefined, defaults to "file" (preserving current behavior).
   * Available built-in backends:
   * - "file": File system (default, current behavior)
   *
   * Custom backends may be registered via MemoryBackendRegistry.
   */
  memoryBackend?: string;

  /**
   * Backend-specific configuration passed during initialization.
   * Structure depends on the backend implementation.
   * When undefined, backend uses its default configuration.
   */
  memoryBackendConfig?: Record<string, unknown>;

  /**
   * When true, enables periodic AI-powered extraction of insights.
   * Default: false.
   * Note: Requires backend with "insights" capability or external service.
   */
  insightExtractionEnabled?: boolean;

  /**
   * Cron expression for insight extraction schedule.
   * Only used when insightExtractionEnabled is true.
   * Default: "0 2 * * *" (daily at 2 AM).
   */
  insightExtractionSchedule?: string;

  /**
   * Minimum interval between insight extractions in milliseconds.
   * Extraction only runs if BOTH this time has elapsed AND memory
   * has grown by more than MIN_INSIGHT_GROWTH_CHARS characters.
   * Default: 86400000 (24 hours).
   */
  insightExtractionMinIntervalMs?: number;
}
```

### 3.8 File Compatibility & Source-of-Truth Semantics

This section defines how pluggable backends interact with Fusion's existing file-based memory infrastructure. **This is critical for compatibility** — all backends must satisfy these semantics to avoid breaking existing call sites.

#### 3.8.1 Return-Shape Compatibility

The following return shapes are **contractually guaranteed** by all backends and must not change:

| Function | Current Behavior | Contract Requirement |
|----------|----------------|---------------------|
| `GET /api/memory` → `{ content }` | Empty string if file absent | Backend `read()` must return `""` when no content exists |
| `readWorkingMemory(rootDir)` | `""` if `.fusion/memory.md` absent | Same — empty string NOT `null` |
| `readInsightsMemory(rootDir)` | `null` if `.fusion/memory-insights.md` absent | Same — `null` NOT `""` |

#### 3.8.2 Canonical Source-of-Truth

**For the `"file"` backend (default):**
- The file `.fusion/memory.md` IS the canonical source
- All reads/writes go directly to the file
- No mirroring or sync required

**For alternative backends:**
- The backend is the canonical source for memory content
- **File mirroring is NOT required** — alternative backends need not maintain `.fusion/memory.md`
- If a backend stores content externally (database, cloud), `.fusion/memory.md` may be stale or absent

#### 3.8.3 File Bridge Adapter (For Dashboard/Agent Compatibility)

When using alternative backends, the dashboard and engine must still work with the canonical path `.fusion/memory.md`. This is achieved through an **adapter layer**:

```typescript
/**
 * Adapter that bridges backend operations to the existing file-based API.
 * Used by dashboard routes and engine prompt builders.
 *
 * For "file" backend: delegates directly to filesystem
 * For alternative backends: translates to backend calls
 */
export class MemoryFileAdapter {
  constructor(private backend: MemoryBackend) {}

  /**
   * Read memory content, mirroring file semantics.
   * - Returns "" for empty/missing content (NOT null)
   */
  async read(): Promise<string> {
    try {
      const content = await this.backend.read();
      return content ?? "";
    } catch {
      // Backend unavailable — return "" to match file behavior
      return "";
    }
  }

  /**
   * Write memory content.
   * Errors are non-fatal (logged, not thrown) to match current behavior.
   */
  async write(content: string): Promise<{ success: boolean }> {
    try {
      await this.backend.write(content);
      return { success: true };
    } catch (error) {
      console.error("[MemoryFileAdapter] Write failed:", error);
      return { success: false };
    }
  }
}
```

#### 3.8.4 File-Service Constraints

Dashboard routes (`/api/memory`) use `readProjectFile`/`writeProjectFile` from `file-service.ts`. Backend adapters used by these routes must respect:

| Constraint | Source | Requirement |
|------------|--------|-------------|
| Path validation | `file-service.ts:55` | Memory path `.fusion/memory.md` must be within project scope |
| File size limit | `MAX_FILE_SIZE = 1MB` | Backend writes must not exceed 1MB |
| Text encoding | `utf-8` | All content encoded as UTF-8 |

#### 3.8.5 Insights File Handling

The `.fusion/memory-insights.md` file has different semantics:

| Function | Current Behavior | Contract Requirement |
|----------|----------------|---------------------|
| `readInsightsMemory(rootDir)` | Returns `null` if absent | Same — `null` NOT `""` |
| `writeInsightsMemory(rootDir, content)` | Creates file + dir if absent | Same behavior |
| Insights extraction automation | Reads from file path | Backend must provide equivalent |

**For alternative backends:**
- Insights storage is backend-defined (no `.fusion/memory-insights.md` required)
- `readInsightsMemory()` may delegate to backend or return `null`
- `writeInsightsMemory()` may delegate to backend or be no-op

#### 3.8.6 Conflict & Error Handling

| Scenario | Behavior |
|----------|----------|
| Backend read fails | Return `""` (graceful degradation) |
| Backend write fails | Log error, return `{ success: false }` (non-fatal) |
| Backend unavailable on init | Fall back to `"file"` backend |
| Backend lacks search | Search endpoint returns 501 Not Implemented |
| Sync failure (insights) | Log error, disable automation for this cycle |

#### 3.8.7 Prompt Instruction Compatibility

Prompt instructions branch based on the configured memory backend type via `resolveMemoryInstructionContext()`:

**Backend-specific behavior:**

| Backend Type | Path Hint | Behavior |
|-------------|-----------|-----------|
| `file` | `.fusion/memory.md` | Full read/write instructions with explicit file path |
| `readonly` | `null` | Read-only instructions, no write/update directives |
| `qmd` / non-file | `null` | Generic instructions without unconditional `.fusion/memory.md` reference |

**API functions:**

- `buildTriageMemoryInstructions(rootDir, settings?)` — Returns backend-appropriate instructions for the specification agent
- `buildExecutionMemoryInstructions(rootDir, settings?)` — Returns backend-appropriate instructions for the executor agent
- `resolveMemoryInstructionContext(settings?)` — Returns `MemoryInstructionContext` with backend metadata and capabilities

**Behavior details:**

- **File backend**: Instructions include `.fusion/memory.md` guidance and read/write directives
- **Readonly backend**: Instructions include read-only wording but no write/update directives
- **QMD/non-file backends**: Instructions are generic without assuming a file path; agents consult the project memory through backend-specific mechanisms
- **Backward compatibility**: When `memoryBackendType` is omitted or unknown, defaults to file behavior

**Invariant:** `memoryEnabled: false` always removes memory instructions regardless of backend type.

---

## 4. Migration Strategy + Compatibility Guardrails

### 4.1 Phased Migration Plan

| Phase | Task | Description |
|-------|------|-------------|
| 1 | FN-1418 | Implement `MemoryBackend` interface + `MemoryBackendRegistry` + `FileMemoryBackend` in `@fusion/core` |
| 2 | FN-1419 | Update engine to use resolved backend; add `memoryBackend`/`memoryBackendConfig` to settings |
| 3 | FN-1420 | Update dashboard routes/UI to use backend abstraction; add backend picker in settings |

### 4.2 Compatibility Matrix

#### Settings

| Setting | Current Behavior | New Behavior | Compatibility |
|---------|-----------------|--------------|---------------|
| `memoryEnabled` | `true` default | `true` default | **Preserved** — same default |
| `memoryEnabled: false` | No instructions, no reads/writes | No instructions, no reads/writes | **Preserved** |
| `memoryBackend` | N/A | `"file"` default | **Preserved** — undefined falls back to `"file"` |
| `memoryBackendConfig` | N/A | `{}` default | **Preserved** — undefined uses backend defaults |
| `insightExtractionEnabled` | `false` default | `false` default | **Preserved** |

#### API Routes

| Route | Current Response | New Response | Compatibility |
|-------|-----------------|--------------|---------------|
| `GET /api/memory` | `{ content: string }` — empty string if absent | `{ content: string }` | **Preserved** |
| `PUT /api/memory` body validation | `content` must be string | `content` must be string | **Preserved** — rejects non-string with 400 |
| `PUT /api/memory` success | `{ success: true }` | `{ success: true }` | **Preserved** |
| `GET /api/memory` when memory disabled | `{ content: string }` (readable) | `{ content: string }` (readable) | **Preserved** — `memoryEnabled` gates prompts, NOT API |
| `PUT /api/memory` when memory disabled | `200 OK` (writes file) | `200 OK` (writes file) | **Preserved** — UI prevents editing, API is open |

#### Insights Memory

| Function | Current Behavior | Contract Requirement | Compatibility |
|----------|----------------|---------------------|---------------|
| `readInsightsMemory()` | `null` if absent | `null` if absent | **Preserved** |
| `writeInsightsMemory()` | Creates dir + file | Creates dir + file | **Preserved** for file backend |
| `insightExtractionEnabled` default | `false` | `false` | **Preserved** |
| `insightExtractionSchedule` default | `"0 2 * * *"` | `"0 2 * * *"` | **Preserved** |
| `insightExtractionMinIntervalMs` default | `86400000` | `86400000` | **Preserved** |
| Automation sync on settings change | Creates/updates/deletes schedule | Same | **Preserved** |

#### Prompt Behavior

| Condition | Current Behavior | New Behavior | Compatibility |
|-----------|-----------------|--------------|---------------|
| `memoryEnabled: true` | Instructions injected | Instructions injected via backend | **Preserved** |
| `memoryEnabled: false` | No instructions | No instructions | **Preserved** |
| Backend read fails | N/A (file always works) | Graceful fallback to file | Safe degradation |
| Backend write fails | N/A | Error logged, non-fatal | Safe degradation |

### 4.3 Must-Not-Break Invariants

1. **File path invariant**: Memory always accessible at `.fusion/memory.md` (file backend is always available as fallback)
2. **Toggle invariant**: `memoryEnabled: false` always means zero memory **prompt** operations — agent instructions are NOT injected, but `GET /api/memory` remains readable and `PUT /api/memory` remains writable
3. **Bootstrap invariant**: `ensureMemoryFile` is always called on init when `memoryEnabled !== false`
4. **Prompt invariant**: Memory instructions always use project-root path (`.fusion/memory.md`), never worktree-local
5. **Non-fatal invariant**: Memory initialization/operation failures never block startup or settings updates
6. **Insights null invariant**: `readInsightsMemory()` returns `null` when `.fusion/memory-insights.md` is absent (not `""`)
7. **Insights write invariant**: `writeInsightsMemory()` creates `.fusion/` directory and `.fusion/memory-insights.md` if absent
8. **Insights defaults invariant**: `insightExtractionEnabled`, `insightExtractionSchedule`, and `insightExtractionMinIntervalMs` retain current default values
9. **Empty-string invariant**: `readWorkingMemory()` and `GET /api/memory` return `""` (empty string) when no content exists — never `null`

### 4.4 Fallback Trigger Conditions

| Condition | Action |
|-----------|--------|
| Configured backend not found | Fall back to `"file"` backend |
| Backend initialization fails | Fall back to `"file"` backend |
| Backend read fails | Return empty string (same as current) |
| Backend write fails | Log error, return success=false (non-fatal) |
| Backend lacks search capability | Search endpoint returns 501 Not Implemented |
| Backend lacks insights capability | Insight extraction automation disabled |

### 4.5 Test Coverage Verification Checklist

Each compatibility matrix row should map to at least one existing test. Cross-reference:

| Matrix Row | Test File | Lines |
|-----------|-----------|-------|
| `memoryEnabled: true` → instructions | `triage.test.ts` | 228–244 |
| `memoryEnabled: false` → no instructions | `triage.test.ts` | 247–264 |
| `memoryEnabled: undefined` → default | `triage.test.ts` | 265–274 |
| `memoryEnabled: true` → executor instructions | `executor.test.ts` | 2176–2183 |
| `memoryEnabled: false` → no executor instructions | `executor.test.ts` | 2186–2194 |
| Memory bootstrap on init | `store.test.ts` | 6010–6021 |
| Memory disabled → no bootstrap | `store.test.ts` | 6023–6061 |
| Memory toggle on → creates file | `store.test.ts` | 6062–6083 |
| Memory toggle on → no overwrite | `store.test.ts` | 6085–6111 |
| File path constant | `project-memory.test.ts` | 18–22 |
| Scaffold headings | `project-memory.test.ts` | 33–46 |
| Idempotent bootstrap | `project-memory.test.ts` | 60–83 |
| Settings UI `memoryEnabled` toggle | `SettingsModal.test.tsx` | (UI test) |

### 4.6 Cross-Linking

This specification is referenced from:
- [Architecture](./architecture.md) — Memory system overview
- [Settings Reference](./settings-reference.md) — `memoryEnabled`, `memoryBackend`, `memoryBackendConfig`, insights settings
- [README](./README.md) — Documentation index

**Related tasks:**
- FN-1418: Implement Core Memory Plugin Infrastructure
- FN-1419: Update Engine to Use Backend Abstraction
- FN-1420: Update Dashboard to Use Backend Abstraction

---

## 5. Downstream Task Alignment

### FN-1418: Implement Core Memory Plugin Infrastructure

**Scope:**
- Define `MemoryBackend` interface in `@fusion/core`
- Implement `MemoryBackendRegistry` class
- Implement `FileMemoryBackend` class
- Add `resolveMemoryBackend()` function
- Update `@fusion/core` exports
- Add tests

**Acceptance criteria:**
- `MemoryBackend` interface covers all required methods
- `FileMemoryBackend` produces identical behavior to current `project-memory.ts`
- Registry correctly resolves and falls back
- All existing tests pass

### FN-1419: Update Engine to Use Backend Abstraction

**Scope:**
- Update triage.ts to use resolved backend for prompt building
- Update executor.ts to use resolved backend for prompt building
- Add `memoryBackend`/`memoryBackendConfig` to settings types
- Update settings defaults and null-as-delete handling
- Add tests

**Acceptance criteria:**
- Memory instructions injected identically when backend is file
- `memoryEnabled: false` still works
- Backend resolution uses settings
- All existing tests pass

### FN-1420: Update Dashboard to Use Backend Abstraction

**Scope:**
- Update dashboard routes to use backend abstraction
- Add backend picker in Settings modal
- Show backend configuration options
- Handle backend errors gracefully in UI
- Add tests

**Acceptance criteria:**
- `GET/PUT /api/memory` work identically via backend
- Backend picker shows available backends
- Backend config editable in UI
- All existing tests pass

---

## Appendix A: Reference Implementation Notes

### A.1 Module Location

The plugin infrastructure belongs in `@fusion/core`:

```
packages/core/src/
├── memory-plugin.ts           # Interface, registry, resolution, errors
├── backends/
│   ├── file-memory-backend.ts  # Default file-based implementation
│   └── index.ts                # Backend exports
└── index.ts                   # Update exports
```

### A.2 Test Strategy

| Test Type | Coverage |
|-----------|----------|
| Unit tests | Each backend class in isolation |
| Integration tests | Backend with real filesystem |
| Contract tests | All backends satisfy `MemoryBackend` interface |
| Compatibility tests | Ensure file backend matches current behavior exactly |

### A.3 Documentation Updates

After implementation:
- Update [Settings Reference](./settings-reference.md) with `memoryBackend` and `memoryBackendConfig`
- Update [Architecture](./architecture.md) memory section with plugin architecture
- Update AGENTS.md if engine prompt wiring changes

---

## Appendix B: Future Extensibility

### B.1 Vector/Semantic Search Backend

A future backend could implement semantic search:

```typescript
class VectorMemoryBackend implements MemoryBackend {
  readonly id = "vector";
  readonly name = "Vector Search";

  hasCapability(capability: MemoryCapability): boolean {
    return capability === "read" || capability === "write" || capability === "search";
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const embedding = await this.embed(query);
    return this.vectorIndex.search(embedding, { limit: options?.limit ?? 10 });
  }
}
```

### B.2 Hybrid Backend

A hybrid backend could combine file persistence with vector search:

```typescript
class HybridMemoryBackend implements MemoryBackend {
  private file = new FileMemoryBackend();
  private vector = new VectorMemoryBackend();

  async read(): Promise<string> {
    return this.file.read();
  }

  async write(content: string): Promise<void> {
    await this.file.write(content);
    await this.vector.reindex(content);
  }

  async search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    if (options?.mode === "semantic") {
      return this.vector.search(query, options);
    }
    return this.fileSearch(query);  // Fallback to keyword search
  }
}
```

---

*Last updated: 2026-04-09*
