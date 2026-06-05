/**
 * Trait registry (U2, R6/R8/R22).
 *
 * One registry resolving trait ids to definitions (flags + hook descriptors)
 * for both built-ins and (later) plugins. Provides:
 *   - registration with `builtin:`-style namespace protection and
 *     restricted-capability enforcement (R22);
 *   - hook-implementation DI (engine registers impls; unregistered hooks
 *     resolve to a no-op + audit warning — degraded, not crashed);
 *   - effective-flag resolution for a column's trait set;
 *   - the save-time / load-time composition validator returning typed
 *     violations with named reason codes, distinguishing `error`
 *     (save-blocked) from `degraded` (load-time advisory).
 *
 * Core stays engine-free: no `@fusion/engine` import. Hook implementations are
 * wired in via `registerTraitHookImpl` (mirrors `setCreateFnAgent`).
 */

import type {
  TraitDefinition,
  TraitFlags,
  TraitHookImpl,
  TraitHookKind,
} from "./trait-types.js";
import { RESTRICTED_TRAIT_FLAGS, traitHookKey } from "./trait-types.js";
import type { WorkflowIrColumn, WorkflowIrColumnTrait } from "./workflow-ir-types.js";

// ── Registration error ──────────────────────────────────────────────────────

/** Named reason codes for a rejected trait registration. */
export type TraitRegistrationReason =
  | "duplicate-id"
  | "builtin-namespace-protected"
  | "restricted-flag"
  | "restricted-guard-hook"
  | "invalid-definition";

export class TraitRegistrationError extends Error {
  readonly reason: TraitRegistrationReason;
  readonly traitId: string;
  constructor(reason: TraitRegistrationReason, traitId: string, message: string) {
    super(message);
    this.name = "TraitRegistrationError";
    this.reason = reason;
    this.traitId = traitId;
  }
}

// ── Composition violation contract ──────────────────────────────────────────

/** Named reason codes for a composition violation. */
export type TraitViolationCode =
  | "complete-with-wip"
  | "two-capacity-traits"
  | "complete-with-intake"
  | "archived-with-wip"
  | "multiple-intake-columns"
  | "unknown-trait";

/** Severity: `error` blocks the save; `degraded` is a load-time advisory — the
 *  definition still loads (per U2's load-time re-validation requirement). */
export type TraitViolationSeverity = "error" | "degraded";

export interface TraitViolation {
  code: TraitViolationCode;
  severity: TraitViolationSeverity;
  /** Column id the violation applies to, or null for workflow-wide violations. */
  columnId: string | null;
  /** The trait ids implicated (for actionable messaging). */
  traitIds: string[];
  message: string;
}

/**
 * Thrown by the store's create/update workflow paths (residual A) when a
 * workflow's trait composition has `error`-severity violations under `save`
 * mode — so trait conflicts reject server-side, not only in the editor. Carries
 * the structured violations so the surface can render them per-column. The
 * dashboard routes map this to a 400 (consistent with `WorkflowIrError`).
 */
export class ColumnTraitValidationError extends Error {
  readonly violations: TraitViolation[];
  constructor(violations: TraitViolation[]) {
    const summary = violations.map((v) => v.message).join("; ");
    super(`Workflow trait composition invalid: ${summary}`);
    this.name = "ColumnTraitValidationError";
    this.violations = violations;
  }
}

/** A simple audit-warning record returned by hook resolution / load-time
 *  re-validation. Modeled as a returned value (not a thrown error and not an
 *  engine logger) so core stays engine-free; callers may forward it to audit. */
export interface TraitAuditWarning {
  kind: "missing-hook-impl" | "degraded-composition";
  traitId?: string;
  hookKind?: TraitHookKind;
  message: string;
}

// ── The registry ────────────────────────────────────────────────────────────

export class TraitRegistry {
  private readonly traits = new Map<string, TraitDefinition>();
  private readonly hookImpls = new Map<string, TraitHookImpl>();

  /** Register a trait. Rejects duplicates, builtin-namespace overrides by
   *  non-builtins, and restricted-capability declarations by non-builtins (R22). */
  register(def: TraitDefinition): void {
    if (!def.id || typeof def.id !== "string") {
      throw new TraitRegistrationError(
        "invalid-definition",
        String(def.id),
        "Trait definition must have a non-empty string id",
      );
    }

    const existing = this.traits.get(def.id);
    if (existing) {
      // A built-in id (or any already-registered id) cannot be overridden.
      if (!def.builtin && existing.builtin) {
        throw new TraitRegistrationError(
          "builtin-namespace-protected",
          def.id,
          `Trait id '${def.id}' is a built-in trait and cannot be overridden by a non-builtin registration`,
        );
      }
      throw new TraitRegistrationError(
        "duplicate-id",
        def.id,
        `Trait id '${def.id}' is already registered`,
      );
    }

    if (!def.builtin) {
      // Non-builtin (plugin) traits cannot declare restricted flags (R22).
      for (const flag of RESTRICTED_TRAIT_FLAGS) {
        if (def.flags?.[flag]) {
          throw new TraitRegistrationError(
            "restricted-flag",
            def.id,
            `Non-builtin trait '${def.id}' may not declare the restricted flag '${flag}'`,
          );
        }
      }
      // Non-builtin traits cannot declare the sync `guard` hook (KTD-2/R22).
      if (def.hooks?.guard) {
        throw new TraitRegistrationError(
          "restricted-guard-hook",
          def.id,
          `Non-builtin trait '${def.id}' may not declare a sync 'guard' hook (built-in only)`,
        );
      }
    }

    this.traits.set(def.id, def);
  }

  getTrait(id: string): TraitDefinition | undefined {
    return this.traits.get(id);
  }

  /** Catalog of all registered traits (for the dashboard endpoint, later). */
  listTraits(): TraitDefinition[] {
    return [...this.traits.values()];
  }

  has(id: string): boolean {
    return this.traits.has(id);
  }

  // ── Hook implementation DI (engine wires impls in) ────────────────────────

  /** Register a hook implementation for a (traitId, hookKind). Called by the
   *  engine (mirrors `setCreateFnAgent`); core never supplies impls. */
  registerTraitHookImpl(traitId: string, hookKind: TraitHookKind, impl: TraitHookImpl): void {
    this.hookImpls.set(traitHookKey(traitId, hookKind), impl);
  }

  /**
   * Deregister a hook implementation for a (traitId, hookKind). After this, a
   * trait that still DECLARES the hook resolves to a no-op + audit warning (the
   * degraded path) rather than executing — this is exactly the "force-disable a
   * plugin → columns degrade to passive" path (U8/KTD-7). Returns true if an
   * impl was present and removed.
   */
  deregisterTraitHookImpl(traitId: string, hookKind: TraitHookKind): boolean {
    return this.hookImpls.delete(traitHookKey(traitId, hookKind));
  }

  /**
   * Remove a trait definition entirely (e.g. when a plugin is fully
   * unregistered with no live dependents). Also drops any registered hook impls
   * for that trait. Returns true if the trait was present. Built-in traits are
   * never removed by this (they are not plugin-owned); callers should only pass
   * plugin-namespaced ids.
   */
  unregisterTrait(traitId: string): boolean {
    const def = this.traits.get(traitId);
    if (!def || def.builtin) return false;
    for (const hookKind of ["guard", "gate", "onEnter", "onExit", "releaseCondition"] as TraitHookKind[]) {
      this.hookImpls.delete(traitHookKey(traitId, hookKind));
    }
    return this.traits.delete(traitId);
  }

  /** Resolve a hook implementation. If the trait declares the hook but no impl
   *  is registered, returns a no-op plus an audit warning (degraded, not
   *  crashed). Returns `{ impl: undefined }` with no warning if the trait does
   *  not declare the hook at all. */
  resolveTraitHook(
    traitId: string,
    hookKind: TraitHookKind,
  ): { impl: TraitHookImpl | undefined; warning?: TraitAuditWarning } {
    const def = this.traits.get(traitId);
    const declared = Boolean(def?.hooks?.[hookKind]);
    const impl = this.hookImpls.get(traitHookKey(traitId, hookKind));
    if (impl) return { impl };
    if (declared) {
      const noop: TraitHookImpl = () => undefined;
      return {
        impl: noop,
        warning: {
          kind: "missing-hook-impl",
          traitId,
          hookKind,
          message: `Trait '${traitId}' declares a '${hookKind}' hook but no implementation is registered; resolving to a no-op`,
        },
      };
    }
    return { impl: undefined };
  }

  // ── Flag resolution ───────────────────────────────────────────────────────

  /** Merged effective flags of a column's traits (OR across booleans). Unknown
   *  trait ids are ignored here (validation surfaces them via
   *  validateColumnTraits). */
  resolveColumnFlags(column: WorkflowIrColumn): TraitFlags {
    const merged: TraitFlags = {};
    for (const ct of column.traits) {
      const def = this.traits.get(ct.trait);
      if (!def) continue;
      for (const [key, value] of Object.entries(def.flags) as [keyof TraitFlags, boolean][]) {
        if (value) merged[key] = true;
      }
    }
    return merged;
  }

  // ── Composition validation ────────────────────────────────────────────────

  /**
   * Validate a workflow's columns' trait composition. Returns typed violations
   * with named reason codes. `mode: "save"` produces `error` severities that
   * block the save; `mode: "load"` degrades the *unknown-trait* violation to an
   * advisory so definitions predating a newly added trait still load (per U2's
   * load-time re-validation requirement). Hard structural conflicts remain
   * errors in both modes (they reflect genuine nonsense, not vocabulary drift).
   */
  validateColumnTraits(
    columns: WorkflowIrColumn[],
    mode: "save" | "load" = "save",
  ): TraitViolation[] {
    const violations: TraitViolation[] = [];

    let intakeColumnCount = 0;

    for (const column of columns) {
      const knownDefs: TraitDefinition[] = [];

      // Unknown trait ids: degradable. In save mode it's an error; in load mode
      // it degrades to an advisory (the rule/vocabulary may have changed under
      // a persisted definition).
      for (const ct of column.traits) {
        const def = this.traits.get(ct.trait);
        if (!def) {
          violations.push({
            code: "unknown-trait",
            severity: mode === "load" ? "degraded" : "error",
            columnId: column.id,
            traitIds: [ct.trait],
            message: `Column '${column.id}' references unknown trait '${ct.trait}'`,
          });
          continue;
        }
        knownDefs.push(def);
      }

      const flags = this.mergeFlags(knownDefs);

      // Capacity traits on this column (traits whose flags set countsTowardWip).
      const capacityTraitIds = knownDefs
        .filter((d) => d.flags.countsTowardWip)
        .map((d) => d.id);

      if (flags.complete && flags.countsTowardWip) {
        violations.push({
          code: "complete-with-wip",
          severity: "error",
          columnId: column.id,
          traitIds: this.traitIdsWithFlags(knownDefs, ["complete", "countsTowardWip"]),
          message: `Column '${column.id}' is both a completion column and counts toward WIP — a terminal column cannot hold a capacity slot`,
        });
      }

      if (capacityTraitIds.length > 1) {
        violations.push({
          code: "two-capacity-traits",
          severity: "error",
          columnId: column.id,
          traitIds: capacityTraitIds,
          message: `Column '${column.id}' has more than one capacity (WIP) trait: ${capacityTraitIds.join(", ")}`,
        });
      }

      if (flags.complete && flags.intake) {
        violations.push({
          code: "complete-with-intake",
          severity: "error",
          columnId: column.id,
          traitIds: this.traitIdsWithFlags(knownDefs, ["complete", "intake"]),
          message: `Column '${column.id}' is both a completion column and an intake column`,
        });
      }

      if (flags.archived && flags.countsTowardWip) {
        violations.push({
          code: "archived-with-wip",
          severity: "error",
          columnId: column.id,
          traitIds: this.traitIdsWithFlags(knownDefs, ["archived", "countsTowardWip"]),
          message: `Column '${column.id}' is archived but counts toward WIP — archived cards must not hold capacity`,
        });
      }

      if (flags.intake) intakeColumnCount += 1;
    }

    if (intakeColumnCount > 1) {
      violations.push({
        code: "multiple-intake-columns",
        severity: "error",
        columnId: null,
        traitIds: [],
        message: `Workflow has ${intakeColumnCount} intake columns; exactly one is allowed`,
      });
    }

    return violations;
  }

  private mergeFlags(defs: TraitDefinition[]): TraitFlags {
    const merged: TraitFlags = {};
    for (const def of defs) {
      for (const [key, value] of Object.entries(def.flags) as [keyof TraitFlags, boolean][]) {
        if (value) merged[key] = true;
      }
    }
    return merged;
  }

  private traitIdsWithFlags(defs: TraitDefinition[], flagKeys: (keyof TraitFlags)[]): string[] {
    return defs
      .filter((d) => flagKeys.some((k) => d.flags[k]))
      .map((d) => d.id);
  }
}

// ── Module-level default registry ────────────────────────────────────────────
//
// A single shared registry instance the built-ins register into and the engine
// wires hook impls into. Tests can construct fresh `new TraitRegistry()`
// instances for isolation.

let defaultRegistry: TraitRegistry | undefined;

export function getTraitRegistry(): TraitRegistry {
  if (!defaultRegistry) defaultRegistry = new TraitRegistry();
  return defaultRegistry;
}

/** Test-only: reset the shared registry (so built-in registration can be
 *  re-exercised in isolation). */
export function __resetTraitRegistryForTests(): void {
  defaultRegistry = undefined;
}

// ── Convenience pass-throughs to the default registry ────────────────────────

export function getTrait(id: string): TraitDefinition | undefined {
  return getTraitRegistry().getTrait(id);
}

export function listTraits(): TraitDefinition[] {
  return getTraitRegistry().listTraits();
}

export function resolveColumnFlags(column: WorkflowIrColumn): TraitFlags {
  return getTraitRegistry().resolveColumnFlags(column);
}

export function validateColumnTraits(
  columns: WorkflowIrColumn[],
  mode: "save" | "load" = "save",
): TraitViolation[] {
  return getTraitRegistry().validateColumnTraits(columns, mode);
}

/**
 * Save-mode composition validation that THROWS (residual A). Runs the registry's
 * `validateColumnTraits` in `save` mode and throws a {@link ColumnTraitValidationError}
 * if any `error`-severity violations are present. `degraded` advisories are
 * ignored (they never block a save). A no-op for `[]`/no-error columns.
 */
export function assertColumnTraitsValid(columns: WorkflowIrColumn[]): void {
  const violations = getTraitRegistry()
    .validateColumnTraits(columns, "save")
    .filter((v) => v.severity === "error");
  if (violations.length > 0) throw new ColumnTraitValidationError(violations);
}

export function registerTraitHookImpl(
  traitId: string,
  hookKind: TraitHookKind,
  impl: TraitHookImpl,
): void {
  getTraitRegistry().registerTraitHookImpl(traitId, hookKind, impl);
}

/** Re-export for callers that only need the column-trait shape. */
export type { WorkflowIrColumnTrait };
