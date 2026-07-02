/**
 * TaskStore responsibility modules (U5 decomposition).
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * The monolithic packages/core/src/store.ts (~17k lines) is being broken into
 * cohesive per-responsibility modules behind the existing TaskStore facade.
 * This barrel re-exports the extracted modules so downstream migration units
 * (U12-U14) can import from a single entry point.
 *
 * Current modules:
 *   - errors: TaskStore error classes + dependency/cycle detectors
 *   - persistence: TaskRow shape, column descriptors, serialization SQL
 *   - file-scope: File Scope parsing and validation
 *   - comments: Activity-log truncation/compaction + prompt-section rewriting
 *   - branch-context: Task branch-context source-metadata parsing
 *   - settings-helpers: Settings canonicalization + deep-merge
 *   - review-state: Task review-state normalization
 *   - shell-safety: Branch-name and path shell-safety guards
 *   - row-types: Database row interfaces for satellite tables
 *
 * Async helper modules (U12-U14, target the PostgreSQL schema via Drizzle):
 *   - async-persistence: task insert/soft-delete/live+forensic reads (U12)
 *   - async-allocator: task-ID allocator reconciliation (U12)
 *   - async-settings: project config/settings read/write (U12)
 *   - async-lifecycle: lineage-integrity gate + lineage clear (U13)
 *   - async-merge-coordination: merge-queue enqueue/lease/release (U13)
 *   - async-archive-lineage: archive snapshots + doc/artifact scoping (U14)
 *   - async-branch-groups: branch-groups + PR entities (U14)
 *   - async-workflow-workitems: workflow work-items + completion handoff (U14)
 *   - async-audit: run-audit events + activity log (U14)
 *   - async-comments-attachments: task documents + artifacts (U14)
 *   - async-events: goal citations + usage events + plugin activations (U14)
 *   - async-search: task search query structure (U14, paired with fts-replacement)
 */

export * from "./errors.js";
export * from "./persistence.js";
export * from "./file-scope.js";
export * from "./comments.js";
export * from "./branch-context.js";
export * from "./settings-helpers.js";
export * from "./review-state.js";
export * from "./shell-safety.js";
export type * from "./row-types.js";
