/**
 * Fusion Model Router (U17 / KTD9).
 *
 * A **selection layer** that picks a `(provider, model)` pair *before* a session
 * starts. It is NOT a new executor: it never adds an executor kind, it only
 * chooses which already-configured CLI/provider runs. Routing is **session-level
 * only** for this unit — per-request mid-session re-routing is deferred (it needs
 * its own design pass on streaming continuity / context-window compatibility /
 * prompt-cache invalidation).
 *
 * ## Conservative v0 signal
 *
 * There is no validated `complexity`/`difficulty` field on tasks or steps today,
 * and prompt size is a weak proxy. So v0 does NOT invent a classifier. It routes
 * only an **allowlist of mechanical traits** (dependabot bumps, lint-only fixes)
 * to a cheap tier; **everything else resolves to the configured default pair**.
 * The signal is isolated behind {@link isMechanicalRoutableContext} so a
 * validated classifier can replace it later without touching the governance,
 * override, or fallback machinery.
 *
 * ## Governance, override, fallback (load-bearing — tested per lane)
 *
 * 1. **Override wins.** If a column-agent (or any caller-supplied) override pins a
 *    pair, the router defers and returns that pair unchanged.
 * 2. **Governance is absolute.** The router NEVER returns a pair an org/project/
 *    user model control forbids — including on the fallback path. A forbidden
 *    cheap pick is dropped and the router falls back; if the default pair is
 *    itself forbidden the router returns it untouched (governance of the default
 *    pair is the resolver/caller's job, not the router's to silently rewrite).
 * 3. **Disabled / unavailable → default pair.** When the router is off, the cheap
 *    tier is unconfigured, or no pick is available, the result is byte-identical
 *    to the supplied default pair.
 *
 * ## Quality guardrail seam
 *
 * A cheap-tier pick carries an `escalation` describing the strong tier to retry
 * with on cheap-tier failure (see {@link RouterDecision.escalation}). v0 wires
 * the seam (the default pair is the escalation target) but does not itself run
 * the retry loop — that lives in the executor/session layer that owns failure
 * detection.
 *
 * ## Telemetry
 *
 * Every decision (including the **counterfactual** model that would have run
 * absent the router) is emitted via the U1 {@link emitUsageEvent} seam so the
 * Command Center can show adoption and realized cost delta versus always-premium.
 * Emission is fail-soft and never alters the returned decision.
 */

import type { Database } from "../db/db.js";
import type { Settings } from "../types.js";
import { emitUsageEvent } from "../tasks/usage-events.js";
import type { ResolvedModelSelection } from "./model-resolution.js";

/** The resolution lanes the router governs. Ungoverned lanes are never touched. */
export type RouterLane = "execution" | "planning" | "validation";

/**
 * Why the router produced the pair it did. Surfaced in telemetry `meta` and
 * usable by callers for diagnostics.
 */
export type RouterReason =
  | "disabled" // router off → default pair
  | "override" // a column-agent/caller override pinned the pair → defer
  | "cheap-tier" // an allowlisted mechanical step routed to the cheap tier
  | "cheap-unconfigured" // router on but no cheap pair configured → default
  | "cheap-forbidden" // cheap pick forbidden by governance → default
  | "not-routable" // step not on the mechanical allowlist → default
  | "no-default"; // no usable default pair to fall back to

/**
 * A `(provider, model)` pair the router can choose. Mirrors
 * {@link ResolvedModelSelection} but with both fields concrete when present.
 */
export interface RouterPair {
  provider?: string;
  modelId?: string;
}

/**
 * Predicate that returns `true` iff a pair is **permitted** by the active model
 * controls (org/project/user governance). The router NEVER returns a pair for
 * which this returns `false` on a routed pick. Supplied by the caller because
 * governance schema lives outside core's resolution layer; when omitted, all
 * pairs are permitted (no governance configured).
 */
export type ModelGovernancePredicate = (pair: RouterPair) => boolean;

/**
 * The signal the router classifies. Neutral, schema-light fields so the router
 * does not depend on task schema that does not exist yet — callers populate from
 * whatever trait/label/source data they have in scope.
 */
export interface RouterTaskContext {
  /** Workflow trait flags on the task/column (e.g. `["dependabot", "lint-only"]`). */
  traits?: readonly string[];
  /** Labels on the task / source issue (e.g. `["dependencies", "lint"]`). */
  labels?: readonly string[];
  /** How the task was created (e.g. a `dependabot` / `renovate` source). */
  source?: string | null;
  /** Task title — used only for conservative keyword matching on the allowlist. */
  title?: string | null;
}

export interface RouteModelInput {
  lane: RouterLane;
  /**
   * The pair resolution would return absent the router — the **counterfactual**.
   * The router falls back to this and emits it as the counterfactual in telemetry.
   */
  defaultPair: ResolvedModelSelection;
  /**
   * A column-agent (or other) override pair. When it carries both provider and
   * model, the router defers to it unconditionally (override wins).
   */
  overridePair?: ResolvedModelSelection | null;
  /** The classification signal. */
  context?: RouterTaskContext;
  settings?: Partial<Settings>;
  /** Governance gate. When omitted, all pairs are permitted. */
  isPermitted?: ModelGovernancePredicate;
}

/** The strong-tier retry target for the quality guardrail. */
export interface RouterEscalation {
  provider?: string;
  modelId?: string;
}

export interface RouterDecision {
  /** The pair to actually use. */
  selection: ResolvedModelSelection;
  /** True iff the router down-routed to the cheap tier. */
  routed: boolean;
  reason: RouterReason;
  lane: RouterLane;
  /** What would have run absent the router (always the supplied default pair). */
  counterfactual: ResolvedModelSelection;
  /**
   * Quality-guardrail seam: the strong tier to retry with if the cheap-tier pick
   * fails. Present only when `routed` is true. v0 sets this to the counterfactual.
   */
  escalation?: RouterEscalation;
}

const DEPENDABOT_SOURCES: ReadonlySet<string> = new Set([
  "dependabot",
  "renovate",
  "renovatebot",
]);

const MECHANICAL_TRAITS: ReadonlySet<string> = new Set([
  "dependabot",
  "dependency-bump",
  "deps",
  "lint-only",
  "lint-fix",
  "lint",
  "formatting",
  "format-only",
]);

const MECHANICAL_LABELS: ReadonlySet<string> = new Set([
  "dependencies",
  "dependabot",
  "deps",
  "lint",
  "lint-only",
  "formatting",
  "style",
]);

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function hasComplete(pair: ResolvedModelSelection | null | undefined): pair is { provider: string; modelId: string } {
  return Boolean(pair?.provider && pair?.modelId);
}

/**
 * Conservative v0 classifier: is this step a mechanical, allowlisted candidate
 * for the cheap tier? Pure and isolated so a validated classifier can replace it
 * later. Returns `true` ONLY for clearly-mechanical signals; the default is
 * `false` (→ default pair).
 */
export function isMechanicalRoutableContext(context: RouterTaskContext | undefined): boolean {
  if (!context) return false;

  if (DEPENDABOT_SOURCES.has(normalize(context.source))) return true;

  for (const trait of context.traits ?? []) {
    if (MECHANICAL_TRAITS.has(normalize(trait))) return true;
  }
  for (const label of context.labels ?? []) {
    if (MECHANICAL_LABELS.has(normalize(label))) return true;
  }

  // Conservative title keyword match: a dependabot/bump or lint-only chore.
  const title = normalize(context.title);
  if (title) {
    if (/\bbump\b/.test(title) && /\bfrom\b/.test(title) && /\bto\b/.test(title)) return true;
    if (title.startsWith("chore(deps)") || title.startsWith("build(deps)")) return true;
    if (/\blint\b/.test(title) && /\b(only|fix|fixes)\b/.test(title)) return true;
  }

  return false;
}

/** Resolve the configured cheap-tier pair, or `undefined` when unconfigured. */
function resolveCheapPair(settings: Partial<Settings> | undefined): RouterPair | undefined {
  const provider = settings?.modelRouterCheapProvider;
  const modelId = settings?.modelRouterCheapModelId;
  if (provider && modelId) return { provider, modelId };
  return undefined;
}

function isRouterEnabled(settings: Partial<Settings> | undefined): boolean {
  return settings?.modelRouterEnabled === true;
}

/**
 * The core selection function. **Pure** (no DB, no telemetry) so it is trivially
 * testable; {@link routeModelAndEmit} wraps it to also emit telemetry.
 *
 * Decision order (each rule is tested):
 *  1. override pinned        → defer (return override, `routed: false`)
 *  2. router disabled        → default pair
 *  3. not mechanical         → default pair
 *  4. cheap tier unconfigured→ default pair
 *  5. cheap pick forbidden   → default pair (governance, incl. fallback path)
 *  6. otherwise              → cheap pick (with escalation seam)
 *
 * Governance also guards the override (an override forbidden by policy is NOT
 * honored — governance is absolute) and is noted on the default-pair paths via
 * `reason`, but the router never rewrites a forbidden default pair: governing the
 * default is the resolver/caller's responsibility, the router only guarantees it
 * does not *introduce* a forbidden pair.
 */
export function routeModel(input: RouteModelInput): RouterDecision {
  const { lane, defaultPair, overridePair, context, settings } = input;
  const isPermitted = input.isPermitted ?? (() => true);
  const counterfactual: ResolvedModelSelection = { ...defaultPair };

  const fallback = (reason: RouterReason): RouterDecision => ({
    selection: { ...defaultPair },
    routed: false,
    reason: hasComplete(defaultPair) ? reason : "no-default",
    lane,
    counterfactual,
  });

  // 1. Override wins — but governance is absolute, so a forbidden override is not
  //    honored; it falls through to default resolution.
  if (hasComplete(overridePair) && isPermitted({ provider: overridePair.provider, modelId: overridePair.modelId })) {
    return {
      selection: { provider: overridePair.provider, modelId: overridePair.modelId },
      routed: false,
      reason: "override",
      lane,
      counterfactual,
    };
  }

  // 2. Disabled → byte-identical default-pair behavior.
  if (!isRouterEnabled(settings)) {
    return fallback("disabled");
  }

  // 3. Conservative allowlist: only mechanical steps are routable.
  if (!isMechanicalRoutableContext(context)) {
    return fallback("not-routable");
  }

  // 4. Cheap tier must be configured.
  const cheap = resolveCheapPair(settings);
  if (!cheap || !hasComplete(cheap)) {
    return fallback("cheap-unconfigured");
  }

  // 5. Governance is absolute — never return a forbidden cheap pick.
  if (!isPermitted({ provider: cheap.provider, modelId: cheap.modelId })) {
    return fallback("cheap-forbidden");
  }

  // 6. Route to the cheap tier, wiring the quality-guardrail escalation seam.
  return {
    selection: { provider: cheap.provider, modelId: cheap.modelId },
    routed: true,
    reason: "cheap-tier",
    lane,
    counterfactual,
    escalation: hasComplete(defaultPair)
      ? { provider: defaultPair.provider, modelId: defaultPair.modelId }
      : undefined,
  };
}

/**
 * {@link routeModel} plus fail-soft telemetry: emits one `session_start` usage
 * event carrying the routing decision and the **counterfactual** model. Emission
 * never alters or blocks the returned decision (the U1 seam is itself fail-soft).
 */
export function routeModelAndEmit(
  db: Database | undefined,
  input: RouteModelInput & { taskId?: string | null; agentId?: string | null; nodeId?: string | null },
): RouterDecision {
  const decision = routeModel(input);
  if (db) {
    emitUsageEvent(db, {
      kind: "session_start",
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      nodeId: input.nodeId ?? null,
      model: decision.selection.modelId ?? null,
      provider: decision.selection.provider ?? null,
      category: "model-router",
      meta: {
        router: true,
        lane: decision.lane,
        routed: decision.routed,
        reason: decision.reason,
        // The counterfactual model that WOULD have run absent the router.
        counterfactualProvider: decision.counterfactual.provider ?? null,
        counterfactualModelId: decision.counterfactual.modelId ?? null,
        escalationProvider: decision.escalation?.provider ?? null,
        escalationModelId: decision.escalation?.modelId ?? null,
      },
    });
  }
  return decision;
}
