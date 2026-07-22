/**
 * Merger strategy, conflict, audit, and auto-recovery policy types + normalizers.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts; re-exported from the browser-safe types barrel.
 */

export type PrStatus = "open" | "closed" | "merged" | "draft";
export type MergeStrategy = "direct" | "pull-request";
export type MergeIntegrationWorktreeMode =
  | "reuse-task-worktree"
  | "cwd-integration-branch" // explicit opt-in; surfaces a warning at startup. See FN-5348.
  | "cwd-main"; // legacy alias for cwd-integration-branch; deprecated. Normalized at read time.

let warnedLegacyCwdMain = false;

export function __resetLegacyCwdMainWarningForTests(): void {
  warnedLegacyCwdMain = false;
}

export function normalizeMergeIntegrationWorktreeMode(
  value: unknown,
): MergeIntegrationWorktreeMode {
  if (value === "reuse-task-worktree" || value === "cwd-integration-branch") {
    return value;
  }

  if (value === "cwd-main") {
    if (!warnedLegacyCwdMain) {
      warnedLegacyCwdMain = true;
      console.warn("[merger] settings.mergeIntegrationWorktree=cwd-main is legacy; normalized to cwd-integration-branch");
    }
    return "cwd-integration-branch";
  }

  return "reuse-task-worktree";
}

export const DIRECT_MERGE_COMMIT_STRATEGIES = ["auto", "always-squash", "always-rebase"] as const;
export type DirectMergeCommitStrategy = (typeof DIRECT_MERGE_COMMIT_STRATEGIES)[number];

export const MERGE_ADVANCE_AUTO_SYNC_MODES = ["off", "ff-only", "stash-and-ff"] as const;
export type MergeAdvanceAutoSyncMode = (typeof MERGE_ADVANCE_AUTO_SYNC_MODES)[number];
export function normalizeMergeAdvanceAutoSyncMode(value: unknown): MergeAdvanceAutoSyncMode {
  return value === "off" || value === "ff-only" || value === "stash-and-ff" ? value : "stash-and-ff";
}
/** How merge conflicts are resolved when the AI agent can't (or shouldn't) decide.
 *
 *  Both `smart-*` strategies share the same cascade: pre-merge fetch +
 *  fast-forward of local main from origin (graceful degrade on failure),
 *  then AI, then auto-resolve lock/generated/trivial files. They differ only
 *  in the final per-file fallback when conflicts remain:
 *
 *  - "smart-prefer-main" (default): fall back to `-X ours` so main's state
 *    wins. Best when concurrent tasks could regress just-merged sibling work.
 *  - "smart-prefer-branch": fall back to `-X theirs` so the task branch wins.
 *    Best when one agent at a time is dominant and you trust their output.
 *  - "ai-only": run AI on every attempt; never silently prefer one side.
 *  - "abort": run AI once; if conflict remains, fail the merge so a human
 *    can resolve it.
 *
 *  Legacy values `"smart"` and `"prefer-main"` are accepted for backwards
 *  compatibility and normalized via {@link normalizeMergeConflictStrategy}.
 *  `"smart"` maps to `"smart-prefer-branch"` (its historical fallback) and
 *  `"prefer-main"` maps to `"smart-prefer-main"`. */
export type MergeConflictStrategy =
  | "smart-prefer-main"
  | "smart-prefer-branch"
  | "ai-only"
  | "abort"
  /** @deprecated use "smart-prefer-branch" */
  | "smart"
  /** @deprecated use "smart-prefer-main" */
  | "prefer-main";

/** Canonical (post-migration) values that the merger actually dispatches on. */
export type CanonicalMergeConflictStrategy = Exclude<
  MergeConflictStrategy,
  "smart" | "prefer-main"
>;

/** Translate legacy `mergeConflictStrategy` values into their canonical form.
 *  Pass-through for already-canonical values; defaults to "smart-prefer-main"
 *  when the input is undefined. */
export function normalizeMergeConflictStrategy(
  value: MergeConflictStrategy | undefined,
): CanonicalMergeConflictStrategy {
  switch (value) {
    case "smart":
      return "smart-prefer-branch";
    case "prefer-main":
      return "smart-prefer-main";
    case undefined:
      return "smart-prefer-main";
    default:
      return value;
  }
}

export const MERGE_STRATEGY_OVERLAP_BEHAVIORS = [
  "flip-to-prefer-branch",
  "warn-only",
  "ignore",
] as const;

export type MergeStrategyOverlapBehavior = (typeof MERGE_STRATEGY_OVERLAP_BEHAVIORS)[number];

export function normalizeMergeStrategyOverlapBehavior(
  value: unknown,
): MergeStrategyOverlapBehavior {
  return typeof value === "string"
    && (MERGE_STRATEGY_OVERLAP_BEHAVIORS as readonly string[]).includes(value)
    ? value as MergeStrategyOverlapBehavior
    : "flip-to-prefer-branch";
}

export const POST_MERGE_AUDIT_MODES = ["block", "warn", "off"] as const;

/** Controls how the merger reacts to a dirty post-merge audit (FN-4333). */
export type PostMergeAuditMode = (typeof POST_MERGE_AUDIT_MODES)[number];

export function normalizePostMergeAuditMode(value: unknown): PostMergeAuditMode {
  return typeof value === "string"
    && (POST_MERGE_AUDIT_MODES as readonly string[]).includes(value)
    ? (value as PostMergeAuditMode)
    : "block";
}

export const MERGE_AUDIT_AUTO_RECOVERY_MODES = ["deterministic-only", "programmatic", "ai-assisted", "off"] as const;

/** Controls how aggressively the merger tries to auto-recover from audit blocks (FN-4315). */
export type MergeAuditAutoRecoveryMode = (typeof MERGE_AUDIT_AUTO_RECOVERY_MODES)[number];

export function normalizeMergeAuditAutoRecovery(value: unknown): MergeAuditAutoRecoveryMode {
  return typeof value === "string"
    && (MERGE_AUDIT_AUTO_RECOVERY_MODES as readonly string[]).includes(value)
    ? (value as MergeAuditAutoRecoveryMode)
    : "ai-assisted";
}

export const MERGER_MODES = ["ai", "deterministic"] as const;

/**
 * Merge execution path (FN-5633).
 *  - "ai" (default): the standalone AI merge path — a clean-room worktree where
 *    an AI agent merges the task branch and an AI reviewer audits it (with
 *    corrective retries) before a fast-forward landing. Bypasses the legacy
 *    scaffolding entirely.
 *  - "deterministic": **DEPRECATED (master-plan U0, 2026-06-21) and INERT.** Once
 *    routed to the legacy `aiMergeTask` pipeline; now ignored — every merge uses
 *    the unified "ai" path (`runAiMerge`). The value is retained (not removed) to
 *    avoid a breaking `@runfusion/fusion` type change, and the engine logs a
 *    one-time deprecation warning when it observes a resolved "deterministic".
 *
 * FNXC:MergerUnification 2026-06-21-19:05: `merger.mode` is published surface, so
 * the type and the `MergerSettings.mode` field stay; only the "deterministic"
 * VALUE is deprecated/inert. Removing the type is a separate breaking change.
 */
export type MergerMode = (typeof MERGER_MODES)[number];

export function normalizeMergerMode(value: unknown): MergerMode {
  return typeof value === "string" && (MERGER_MODES as readonly string[]).includes(value)
    ? (value as MergerMode)
    : "ai";
}

/** Settings for the AI merge path (FN-5633). */
export interface MergerSettings {
  /**
   * Which merge path to use. Default: "ai".
   * @deprecated master-plan U0 (2026-06-21): the value is inert — every merge now
   * uses the unified AI merge path (`runAiMerge`). Field retained as published
   * surface; "deterministic" only triggers a one-time deprecation warning.
   */
  mode?: MergerMode;
  /** How many AI corrective rounds before landing the best result (advisory) or
   *  hard-failing (blocking). Default: 3. The reviewer uses the project's
   *  validator/reviewer model lane — there is no merge-specific model setting. */
  maxReviewPasses?: number;
  /** Dangerous compatibility escape hatch for the AI merge landing path.
   *  When true (default for resolved project settings), Fusion restores the legacy
   *  stash → fast-forward → restore behavior when the checked-out integration
   *  worktree is dirty. Set false to explicitly opt out and fail closed before
   *  unrelated local edits can be reintroduced after landing. */
  allowDirtyLocalCheckoutSync?: boolean;
}

export const AUTO_RECOVERY_MODES = ["off", "deterministic-only", "programmatic", "ai-assisted"] as const;

export type AutoRecoveryMode = (typeof AUTO_RECOVERY_MODES)[number];

export type AutoRecoveryFailureClass =
  | "file-scope-invariant"
  | "post-squash-audit-blocker"
  | "branch-cross-contamination"
  | "branch-conflict-tripwire"
  | "branch-conflict-recovery-exhausted"
  | "branch-conflict-unrecoverable"
  | "message-delivery-failure";

export interface AutoRecoverySettings {
  mode: AutoRecoveryMode;
  perClass?: Partial<Record<AutoRecoveryFailureClass, AutoRecoveryMode>>;
  maxRetries?: number;
}

export function normalizeAutoRecovery(value: unknown): AutoRecoverySettings {
  const fallback: AutoRecoverySettings = { mode: "deterministic-only", maxRetries: 3 };
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as {
    mode?: unknown;
    perClass?: unknown;
    maxRetries?: unknown;
  };
  const mode = typeof candidate.mode === "string" && (AUTO_RECOVERY_MODES as readonly string[]).includes(candidate.mode)
    ? candidate.mode as AutoRecoveryMode
    : fallback.mode;
  const perClass = typeof candidate.perClass === "object" && candidate.perClass
    ? Object.fromEntries(
      Object.entries(candidate.perClass as Record<string, unknown>)
        .filter(([k, v]) => (
          [
            "file-scope-invariant",
            "post-squash-audit-blocker",
            "branch-cross-contamination",
            "branch-conflict-tripwire",
            "branch-conflict-recovery-exhausted",
            "branch-conflict-unrecoverable",
            "message-delivery-failure",
          ].includes(k)
          && typeof v === "string"
          && (AUTO_RECOVERY_MODES as readonly string[]).includes(v)
        )),
    ) as Partial<Record<AutoRecoveryFailureClass, AutoRecoveryMode>>
    : undefined;
  const maxRetries = typeof candidate.maxRetries === "number" && Number.isFinite(candidate.maxRetries)
    ? Math.max(0, Math.floor(candidate.maxRetries))
    : fallback.maxRetries;

  return { mode, perClass, maxRetries };
}
/** Policy for handling task execution when the selected node is unavailable/unhealthy. */
export type UnavailableNodePolicy = "block" | "fallback-local";

export type OwningNodeHandoffPolicy = "block" | "reassign-to-local" | "reassign-any-healthy";
