import type { TFunction } from "i18next";
import type { PlannerOverseerState, PlannerOverseerRuntimeSnapshot } from "@fusion/core";

/**
 * FNXC:PlannerOversight 2026-07-04-18:05:
 * FN-7563: the `TaskCard` planner-overseer badge previously printed the raw
 * kebab-case runtime state (e.g. `awaiting-confirmation`) with a bare
 * `Planner overseer: awaiting-confirmation` tooltip — an operator on an
 * `in-review` task had no explanation of what was being confirmed or why.
 * This module is the single source of truth for (a) a human-readable label
 * per non-idle `PlannerOverseerState`, and (b) an explanatory tooltip string
 * composed from the transient `PlannerOverseerRuntimeSnapshot` fields the
 * engine already populates (`reason`, `watchedStage`, `signal`,
 * `pendingConfirmation`). It is presentation-only: a pure function of the
 * snapshot it is given. It must NOT re-derive, cache, or mutate overseer
 * state — the snapshot itself remains owned by FN-7511/FN-7512/FN-7531.
 *
 * Deliberately free of React/engine imports (only TYPE imports from
 * `@fusion/core`) so it stays trivially unit-testable and safe under the
 * dashboard's `@fusion/core` -> `packages/core/src/types.ts` vite alias.
 */

/** Human-readable label for a non-idle planner-overseer state. Falls back to the raw state for future/unknown enum values so a new state never silently disappears. */
export function plannerOverseerStateLabel(
  state: PlannerOverseerState,
  t?: TFunction<"app">,
): string {
  const translate: (key: string, fallback: string, opts?: Record<string, unknown>) => string =
    t ?? ((_key, fallback) => fallback);
  switch (state) {
    case "watching":
      return translate("tasks.plannerOverseerState.watching", "Overseer watching");
    case "steering":
      return translate("tasks.plannerOverseerState.steering", "Overseer steering");
    case "recovering":
      return translate("tasks.plannerOverseerState.recovering", "Overseer recovering");
    case "awaiting-confirmation":
      return translate("tasks.plannerOverseerState.awaitingConfirmation", "Awaiting confirmation");
    case "idle":
      return translate("tasks.plannerOverseerState.idle", "Overseer idle");
    default:
      return state;
  }
}

/**
 * Composes the badge tooltip: leads with the human-readable `reason` when
 * present (verbatim, mirroring the `taskDetail.oversight.explainReason`
 * wording), appends the watched stage/signal when known, and — for
 * `awaiting-confirmation` — appends a sentence stating a human decision is
 * pending. Never emits the literal `undefined`; every optional field has a
 * graceful fallback clause instead.
 */
export function plannerOverseerBadgeTooltip(
  snapshot: Pick<PlannerOverseerRuntimeSnapshot, "state" | "reason" | "watchedStage" | "signal" | "pendingConfirmation">,
  t?: TFunction<"app">,
): string {
  const translate: (key: string, fallback: string, opts?: Record<string, unknown>) => string =
    t ??
    ((_key, fallback, opts) => {
      if (!opts) return fallback;
      return Object.entries(opts).reduce(
        (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value)),
        fallback,
      );
    });

  const parts: string[] = [];

  if (snapshot.reason) {
    parts.push(snapshot.reason);
  } else {
    parts.push(
      translate("tasks.plannerOverseerStateTooltip.stateOnly", "Planner overseer: {{label}}", {
        label: plannerOverseerStateLabel(snapshot.state, t),
      }),
    );
  }

  if (snapshot.watchedStage) {
    parts.push(
      snapshot.signal
        ? translate(
            "tasks.plannerOverseerStateTooltip.watchingStageSignal",
            "Watching {{stage}} ({{signal}}).",
            { stage: snapshot.watchedStage, signal: snapshot.signal },
          )
        : translate("tasks.plannerOverseerStateTooltip.watchingStage", "Watching {{stage}}.", {
            stage: snapshot.watchedStage,
          }),
    );
  }

  if (snapshot.state === "awaiting-confirmation" || snapshot.pendingConfirmation) {
    parts.push(
      translate(
        "tasks.plannerOverseerStateTooltip.pendingConfirmation",
        "A human decision is required before the overseer can continue.",
      ),
    );
  }

  return parts.join(" ");
}
