/**
 * Trait model (U2). A trait is declarative flags + optional config schema +
 * optional executable lifecycle hook *descriptors*. Per KTD-2 there are two
 * guard classes:
 *   - `guard`  — sync, in-lock, fast/pure (DB reads only). BUILT-IN ONLY.
 *   - `gate`   — async, pre-evaluated outside the lock; the plugin-facing
 *                surface. The verdict is recorded and re-checked cheaply in-lock.
 *
 * Hooks here are *descriptors* (what the trait declares it participates in);
 * the executable implementations are registered separately by the engine via
 * the core→engine DI seam (mirrors `setCreateFnAgent`). This keeps core
 * engine-free: core never imports `@fusion/engine`.
 */

/** The set of hook points a trait can declare (KTD-2). */
export type TraitHookKind = "guard" | "gate" | "onEnter" | "onExit" | "releaseCondition";

/** All declarative trait flags. Derived from the Trait Vocabulary table.
 *  Every flag is optional; an absent flag means `false`. Flags compose by OR
 *  across a column's traits (see resolveColumnFlags). */
export interface TraitFlags {
  /** Cards in this column count against a WIP/capacity limit (substrate-enforced). */
  countsTowardWip?: boolean;
  /** Terminal-success column; satisfies dependencies. RESTRICTED (built-in only). */
  complete?: boolean;
  /** Globally archived; hidden from the board. RESTRICTED (built-in only). */
  archived?: boolean;
  /** Hidden from the board lane (e.g. archived columns). */
  hiddenFromBoard?: boolean;
  /** Leaving this column hard-cancels in-flight work (abort-on-exit). */
  abortOnExit?: boolean;
  /** Cards cannot leave until explicit human approval. */
  humanReview?: boolean;
  /** Where new cards land; exactly one per workflow (validated). */
  intake?: boolean;
  /** Passive dwell column with a release condition. */
  hold?: boolean;
  /** Participates in merge/PR orchestration (enqueues onto the merge queue). */
  mergeOrchestration?: boolean;
  /** Entry to this column is blocked until the merge-class node completed. */
  mergeBlocker?: boolean;
  /** Card progress/fields are reset on entry (reopen semantics). */
  resetOnEntry?: boolean;
  /** Cumulative active-time accounting runs on enter/exit. */
  timing?: boolean;
  /** Stall detection is evaluated by the sweep for cards dwelling here. */
  stallDetection?: boolean;
  /** Emits notifications on enter/exit. */
  notify?: boolean;
  /** A gate (advisory or blocking) is evaluated before entry. */
  gate?: boolean;
}

/** The flag keys that are restricted to built-in traits (R22, KTD-7). A
 *  non-builtin (plugin) trait declaring any of these is rejected at
 *  registration. The sync `guard` hook descriptor is restricted separately. */
export const RESTRICTED_TRAIT_FLAGS = ["complete", "archived"] as const;
export type RestrictedTraitFlag = (typeof RESTRICTED_TRAIT_FLAGS)[number];

/** A trait's hook descriptors — *what* the trait declares it participates in.
 *  `true` means "this trait has a hook of this kind"; the implementation is
 *  registered separately via the engine DI seam. */
export interface TraitHookDescriptors {
  /** Sync, in-lock guard. BUILT-IN ONLY (KTD-2/R22). */
  guard?: boolean;
  /** Async, pre-evaluated gate. Plugin-facing surface. */
  gate?: boolean;
  /** Post-commit, async, idempotent enter effect. */
  onEnter?: boolean;
  /** Post-commit, async, idempotent exit effect. */
  onExit?: boolean;
  /** Release-condition evaluation for hold columns (sweep-driven). */
  releaseCondition?: boolean;
}

/** A declarative description of a trait's config schema. Lightweight by design
 *  (U2 ships the shapes; richer validation lands with each behavior unit). */
export interface TraitConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "object" | "array";
  required?: boolean;
  /** For `enum` fields: the allowed values. */
  enumValues?: readonly string[];
  description?: string;
}

export interface TraitConfigSchema {
  fields: TraitConfigField[];
}

/** A trait definition: declarative flags + optional config schema + optional
 *  hook descriptors. Built-in traits set `builtin: true`. */
export interface TraitDefinition {
  id: string;
  name: string;
  description?: string;
  flags: TraitFlags;
  configSchema?: TraitConfigSchema;
  hooks?: TraitHookDescriptors;
  /** True for the 14 built-in traits; plugin/custom traits leave this falsy.
   *  Restricted capabilities (R22) are allowed only when `builtin` is true. */
  builtin?: boolean;
}

// ── Hook implementation DI seam (core→engine) ───────────────────────────────
//
// Implementations of trait hooks are NOT defined in core (core is engine-free).
// The engine registers them via `registerTraitHookImpl` the way it wires
// `setCreateFnAgent`. Core resolves an implementation through
// `getTraitHookImpl`; an unregistered hook resolves to a no-op (the registry's
// `resolveTraitHook` returns a no-op + an audit warning, see trait-registry).
//
// The impl signature is intentionally opaque here: core never invokes hooks
// directly (the store/sweep do, in engine-adjacent code), so core only needs to
// store/retrieve the registration. Using `unknown` keeps core free of engine
// types while remaining type-safe at the registration boundary.

/** A registered hook implementation. Opaque to core; the engine supplies a
 *  concrete callable and casts at its own call sites. */
export type TraitHookImpl = (...args: unknown[]) => unknown;

/** Stable key for a (traitId, hookKind) implementation registration. */
export function traitHookKey(traitId: string, hookKind: TraitHookKind): string {
  return `${traitId}::${hookKind}`;
}
