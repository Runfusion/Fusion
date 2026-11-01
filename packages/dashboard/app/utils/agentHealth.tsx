import type { JSX } from "react";
import { Bot, Heart, Activity, Pause } from "lucide-react";
import { describeHeartbeatThrottle } from "@fusion/core/heartbeat-recovery-state";
/*
FNXC:HeartbeatIdleBackoff 2026-11-01-01:20 (RUFU-268):
The health pill needs the SAME ladder the scheduler is deferring this agent with, or an agent that is
idling on purpose gets called Unresponsive at the very moment the engine decided to leave it alone. It is
imported as a value from `@fusion/core` — which the browser build aliases to the types-only leaf — because
a root-barrel value that lives only in the Node index resolves to `undefined` in the shipped bundle with
no build error (RUFU-220). The module imports nothing, so it is legal in that leaf.
*/
import { resolveHeartbeatSilenceBudgetMs } from "@fusion/core";
import type { Agent } from "../api";
import { resolveHeartbeatIntervalMs } from "./heartbeatIntervals";
import { elapsedSinceMs } from "./dataFreshness";
import { PAUSE_REASON_LABELS } from "./stallReason";

// Heartbeat scheduling depends on both state and `runtimeConfig.enabled`.
// Durable agents with heartbeat disabled should render distinctly from healthy
// or merely-starting agents, while task-worker agents still follow their
// execution lifecycle regardless of the scheduler toggle.

/**
 * Grace multiplier applied to an agent's configured interval before flagging
 * it Unresponsive. We require several missed scheduled ticks before raising
 * the alarm — momentary timer jitter, an engine restart, or a single skipped
 * tick should never flip the UI to "Unresponsive".
 */
const HEARTBEAT_GRACE_MULTIPLIER = 4;

/**
 * Staleness floor. Even on an agent configured for 1s heartbeats we don't
 * want the UI flickering between Healthy/Unresponsive on every tick. Five
 * minutes is enough wall-clock buffer for any reasonable agent to recover
 * from an engine pause/resume cycle.
 */
const MIN_HEARTBEAT_STALENESS_MS = 5 * 60_000;

/*
FNXC:FleetVerdict 2026-09-02-05:18 (RUFU-176):
`AgentHealthStatus.label` is a plain string, so the RUFU-176 fleet-verdict classifier (which buckets an agent as
"no heartbeat" by label membership) would otherwise duplicate these literals and drift silently from the producer.
Exported so both surfaces read the SAME strings; rendering is byte-identical — only the literals moved here.
*/
export const AGENT_HEALTH_LABEL_HEARTBEAT_DISABLED = "Heartbeat Disabled";
export const AGENT_HEALTH_LABEL_UNRESPONSIVE = "Unresponsive";
/*
FNXC:AgentHealthPill 2026-09-02-22:35 (RUFU-177):
The pill module has no `t`, but the approval-wait wording must MATCH the shipped catalog
`agents.stallReason.awaiting-approval` ("Waiting for approval", rendered via t in AgentsView's stall
column) rather than invent a new phrase, so the agent surfaces and the pill agree on the words. The
stall RESOLVER's chip keeps its own `stall.agent-approval.badgeLabel` ("Awaiting approval") — different
namespace, different surface; the pill mirrors the catalog label the Fleet/Agents views already say.
*/
export const AGENT_HEALTH_LABEL_AWAITING_APPROVAL = "Waiting for approval";
/*
FNXC:ProviderThrottleIsTransient 2026-09-30-14:35 (RUFU-286):
The label the throttle branch prints. Exported for the same reason the two literals above are: the
fleet-verdict classifier buckets by label membership, so the words must be ONE constant shared by
producer and consumer rather than a copy that can drift.
*/
export const AGENT_HEALTH_LABEL_RATE_LIMITED = "Rate limited";

/** Shape of the health status returned by getAgentHealthStatus */
export interface AgentHealthStatus {
  label: string;
  icon: JSX.Element;
  color: string;
  /** True when label only mirrors agent.state and adds no extra context */
  stateDerived: boolean;
  /** Human-readable reason for the current status (e.g. "No heartbeat for 45m (threshold: 20m)") */
  reason?: string;
}

type AgentHealthInput = Pick<
  Agent,
  | "state"
  | "lastHeartbeatAt"
  | "lastError"
  | "pauseReason"
  | "runtimeConfig"
  | "metadata"
  | "name"
  | "role"
  | "taskId"
  | "pendingApprovalCount"
>;

/**
 * Compute the staleness threshold for an agent. Elapsed time beyond this is
 * classified as Unresponsive.
 *
 * Uses the same interval resolver as the dashboard dropdown — if the agent
 * has no explicit heartbeatIntervalMs persisted, the server-side default
 * (1h) applies — so agents that were never configured (no dropdown write)
 * and agents that were explicitly configured both get consistent treatment,
 * differing only by their scheduled cadence.
 */
/**
 * Exported for RUFU-176's org-node heartbeat countdown: the card must call the SAME threshold its own health label
 * uses, so "overdue" on the countdown and "Unresponsive" on the health glyph are one fact, not two that can drift.
 * FNXC:FleetVerdict 2026-09-02-06:25 (RUFU-176).
 */
export function getStalenessThresholdMs(
  runtimeConfig?: Record<string, unknown>,
  heartbeatMultiplier: number = 1,
): number {
  const intervalMs = resolveHeartbeatIntervalMs(runtimeConfig?.heartbeatIntervalMs);
  const resolvedMultiplier = Number.isFinite(heartbeatMultiplier) && heartbeatMultiplier > 0
    ? heartbeatMultiplier
    : 1;

  /*
  FNXC:AgentHeartbeat 2026-07-17-00:25:
  FN-8190 requires dashboard health labels to use the project-resolved heartbeat
  multiplier exactly once. The dashboard cannot import engine timing helpers, so
  callers supply this settings value and raw persisted intervals remain the input.
  */
  const effectiveIntervalMs = Math.max(1000, Math.round(intervalMs * resolvedMultiplier));

  /*
  FNXC:HeartbeatIdleBackoff 2026-11-01-01:20 (RUFU-268):
  The idle ladder stretches this agent's dispatch cadence, so `lastHeartbeatAt` legitimately stops moving
  while it idles. The grace window therefore grows by THAT agent's own step — read off its own persisted
  streak — and by nobody else's: an agent that is not idling gets back `effectiveIntervalMs` byte-identically,
  which is the guarantee that today's Unresponsive timing for busy agents does not move by a millisecond.

  The ceiling comes from the code default rather than `settings.heartbeatIdleBackoffCapMs`, because this
  resolver takes no settings input beyond the multiplier its callers already pass. That errs in exactly one
  direction: with a lowered cap the window is more generous than the engine's wait, and only an operator who
  raises the cap past 30 minutes could make it tighter than the deferral — and 4× a 30-minute step is still
  a two-hour window. The safe direction is the one that cannot falsely call an agent Unresponsive.
  */
  const silenceBudgetMs = resolveHeartbeatSilenceBudgetMs({
    streak: runtimeConfig?.heartbeatIdleStreak,
    baseIntervalMs: effectiveIntervalMs,
  });
  return Math.max(silenceBudgetMs * HEARTBEAT_GRACE_MULTIPLIER, MIN_HEARTBEAT_STALENESS_MS);
}

/**
 * Format milliseconds into a human-readable duration string (e.g. "5m", "1h 20m", "2h").
 *
 * Exported for RUFU-176's org-node heartbeat countdown, which sits in the same card as the `reason` string built here
 * ("No heartbeat for 2h (threshold: 20m)"); one formatter keeps the two durations on a card reading identically.
 * FNXC:FleetVerdict 2026-09-02-06:30 (RUFU-176).
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function isTaskWorkerAgent(agent: AgentHealthInput): boolean {
  const metadata = agent.metadata as Record<string, unknown> | null | undefined;
  if (metadata) {
    if (metadata.agentKind === "task-worker") return true;
    if (metadata.taskWorker === true) return true;
    if (metadata.managedBy === "task-executor") return true;
  }

  return Boolean(
    agent.role === "executor" &&
    agent.name?.startsWith("executor-") &&
    agent.taskId,
  );
}

/**
 * Computes a single canonical health status for an agent based on its
 * state, runtimeConfig, and last heartbeat timestamp.
 *
 * Health labels (in priority order):
 * - "Error" — agent.state === "error" (uses lastError if available)
 * - "Paused" — agent.state === "paused" (uses pauseReason if available)
 * - "Running" — agent.state === "running", or a detected task worker in "active"
 * - "Heartbeat Disabled" — durable agent with `runtimeConfig.enabled === false`
 * - "Starting..." — state === "active" && no lastHeartbeatAt
 * - "Idle" — state !== "active" && no lastHeartbeatAt
 * - "Healthy" — heartbeat is fresh within the configured interval's 4× grace window
 * - "Unresponsive" — heartbeat exceeded the configured interval's 4× grace window
 *
 * @param agent - The agent object (partial Agent shape is accepted)
 * @param heartbeatMultiplier - Project-resolved heartbeat interval multiplier
 * @param dataAsOfMs - When this agent record was last confirmed fresh by the server (SWR envelope
 *   `savedAt` for a hydrated snapshot, fetch time for live data). Omit only for provably-live data.
 * @returns A health status object with label, icon, color, and stateDerived metadata
 */
function getHeartbeatRepairMetadata(agent: AgentHealthInput): {
  repairedAt?: string;
  staleAtRepair?: boolean;
  staleRepairReason?: string;
} {
  const metadata = agent.metadata as Record<string, unknown> | null | undefined;
  const raw = metadata?.heartbeatTimerRepair;
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  return {
    repairedAt: typeof value.repairedAt === "string" ? value.repairedAt : undefined,
    staleAtRepair: typeof value.staleAtRepair === "boolean" ? value.staleAtRepair : undefined,
    staleRepairReason: typeof value.staleRepairReason === "string" ? value.staleRepairReason : undefined,
  };
}

/*
FNXC:AgentHealthPill 2026-09-02-22:35 (RUFU-177):
A pending permission request was the one wait the health pill could not see. The engine's approval gate
parks an agent with `pauseReason: "awaiting-approval"`, and the approval COUNT is a separate read-path
enrichment (`withPendingApprovalCounts` on the agent API routes). Before RUFU-177 the pill ignored the
count entirely: an agent blocked on the gate printed "Running" while its state still said running, or
"Unresponsive"/"Idle" once its heartbeat aged out WHILE it sat waiting, and the request itself only
appeared in the approvals inbox. Same false-flowing defect RUFU-177 fixes on cards: the fact existed,
the surface never looked at it.

Precedence ladder (spec Step 4): `Error` > named non-approval pause > AWAITING APPROVAL > heartbeat
verdicts > `Running`/`Healthy`. The approval state deliberately OUTRANKS the heartbeat-unresponsive
branches: an agent parked at the gate stops heartbeating, so heartbeat staleness is the SYMPTOM of the
wait, not a competing diagnosis — reporting "Unresponsive" for it told operators to go kill a process
that was merely waiting for a click. The trade is recorded honestly: approval rows can outlive a dead
session, so a stale count can mask a dead agent's "Unresponsive" until the row clears; the spec accepts
that because the count is what the operator can act on, and the org-chart activity line reads the same
ladder. `pauseReason: "awaiting-approval"` is translated in the paused branch to the SAME label, so a
park and a count can never disagree on the pill.

Deliberate non-effect: `resolveFleetVerdictBucket` takes `state` first, so a running agent keeps its
`active` Fleet strip bucket whatever this label says, and every agent that CAN reach this site is
already `waitingHuman` there by `pendingApprovalCount`/`pauseReason`. The strip's four counts cannot shift.
*/
function awaitingApprovalHealthStatus(): AgentHealthStatus {
  return {
    label: AGENT_HEALTH_LABEL_AWAITING_APPROVAL,
    icon: <Pause size={14} />,
    color: "var(--state-paused-text)",
    stateDerived: false,
  };
}

export function getAgentHealthStatus(
  agent: AgentHealthInput,
  heartbeatMultiplier: number = 1,
  dataAsOfMs?: number,
): AgentHealthStatus {
  const { state, lastHeartbeatAt, lastError, pauseReason, runtimeConfig } = agent;
  const isTaskWorker = isTaskWorkerAgent(agent);
  const isHeartbeatEnabled = isTaskWorker || runtimeConfig?.enabled !== false;

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:35 (RUFU-286):
  A provider throttle left a pill printing the raw upstream body — for the reference incident that
  meant `429 rate_limit_error … unknown model …`, which reads as "the model name is wrong, go fix a
  credential" while the heartbeat timer was already holding a bounded re-probe. `lastError` is an
  upstream wrapper body, not a Fusion judgment, so it may only headline when NOTHING better is known.
  A live cooldown therefore outranks it: the label says the provider rate limited us and the engine
  will re-probe, and the raw body is demoted to `reason` (tooltip evidence) instead of the headline.

  Ranked ABOVE the raw-body print but BELOW a permission decision: a pending approval is the only one of
  the two a person can act on, and the cooldown keeps running underneath either way. That has a consequence
  the first draft of this branch got wrong — it excluded approvals and let the case fall through to the
  `state === "error"` print below, so the agent with BOTH a throttle and an approval was still shown the
  raw `unknown model` body, which is the exact misdiagnosis this branch exists to remove. The approval
  therefore has to be answered here, by delegating to the shared approval status, not by exclusion. Note
  this is an intersection-only change: `state: "error"` outranking the approval count is the pre-existing
  documented contract and stays untouched for every non-throttled agent.
  */
  const throttle = describeHeartbeatThrottle(agent);
  if (throttle?.kind === "throttle-cooldown") {
    if ((agent.pendingApprovalCount ?? 0) > 0 || pauseReason === "awaiting-approval") {
      return awaitingApprovalHealthStatus();
    }
    return {
      label: AGENT_HEALTH_LABEL_RATE_LIMITED,
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
      reason: [
        `Provider rate limited — automatic retry scheduled for ${throttle.retryingAt} (attempt ${throttle.throttleStreak}).`,
        lastError ? `Last provider error: ${lastError}` : null,
      ].filter(Boolean).join(" "),
    };
  }

  // Explicit non-running states always take precedence.
  if (state === "error") {
    return {
      label: lastError ?? "Error",
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: !lastError,
    };
  }

  if (state === "paused") {
    /*
    FNXC:StallReason 2026-09-01-18:47 (RUFU-175):
    A paused agent used to print its raw pauseReason CODE in the health pill ("Paused:
    error-retry-exhausted") — the same unmapped-code leak the stall resolver fixes on cards. Route a
    known code through the SHARED pause-reason table so the pill says the same human words every other
    surface says ("Automatic retries exhausted"); the table phrases are complete labels, so they are
    used whole rather than re-prefixed with "Paused:". An unrecognized code keeps the old
    `Paused: <raw>` fallback so an engine reason the table does not list yet still shows verbatim
    instead of silently degrading to "Paused", and a pause with no reason stays "Paused".
    */
    const knownLabel: string | undefined = pauseReason ? PAUSE_REASON_LABELS[pauseReason] : undefined;
    let label = pauseReason ? (knownLabel ?? `Paused: ${pauseReason}`) : "Paused";
    /*
    FNXC:AgentHealthPill 2026-09-02-22:35 (RUFU-177): completion criterion — an approval-PARKED agent
    (state paused, pauseReason awaiting-approval) must read "Waiting for approval" on every pill surface,
    byte-identical to what the pendingApprovalCount branch prints below. The stall resolver's chip keeps
    its own "Awaiting approval" wording; the pill mirrors the catalog label the Fleet/Agents views say.
    */
    if (pauseReason === "awaiting-approval") label = AGENT_HEALTH_LABEL_AWAITING_APPROVAL;
    return {
      label,
      icon: <Pause size={14} />,
      color: "var(--state-paused-text)",
      stateDerived: !pauseReason,
    };
  }

  /*
  FNXC:AgentHealthPill 2026-09-02-22:35 (RUFU-177): the count signal sits right after the explicit-state
  branches — see the ladder above: only Error and a named non-approval pause outrank it; every heartbeat
  verdict and Running/Healthy below it lose to a pending approval.
  */
  if ((agent.pendingApprovalCount ?? 0) > 0) return awaitingApprovalHealthStatus();

  if (state === "running" || (isTaskWorker && state === "active")) {
    return {
      label: "Running",
      icon: <Activity size={14} />,
      color: "var(--state-active-text)",
      stateDerived: true,
    };
  }

  if (!isHeartbeatEnabled) {
    return {
      label: AGENT_HEALTH_LABEL_HEARTBEAT_DISABLED,
      icon: <Pause size={14} />,
      color: "var(--state-paused-text)",
      stateDerived: false,
    };
  }

  // No heartbeat data yet
  if (!lastHeartbeatAt) {
    return {
      label: state === "active" ? "Starting..." : "Idle",
      icon: <Bot size={14} />,
      color: "var(--text-muted)",
      stateDerived: false,
    };
  }

  const heartbeatRepair = getHeartbeatRepairMetadata(agent);
  if (heartbeatRepair.staleAtRepair && heartbeatRepair.repairedAt) {
    const repairedMs = Date.parse(heartbeatRepair.repairedAt);
    const lastHeartbeatMs = Date.parse(lastHeartbeatAt);
    if (Number.isFinite(repairedMs) && Number.isFinite(lastHeartbeatMs) && lastHeartbeatMs < repairedMs) {
      return {
        label: AGENT_HEALTH_LABEL_UNRESPONSIVE,
        icon: <Activity size={14} />,
        color: "var(--state-error-text)",
        stateDerived: false,
        reason: heartbeatRepair.staleRepairReason ?? "Heartbeat scheduler repaired a missing timer; waiting for recovery heartbeat",
      };
    }
  }

  // Every non-task-worker agent has an effective interval — either explicitly
  // configured, or the scheduler's 1h default. Compare elapsed time to that
  // interval (with grace) rather than to `heartbeatTimeoutMs`, which is the
  // per-run work budget and has nothing to do with between-tick freshness.
  const lastHeartbeat = Date.parse(lastHeartbeatAt);
  const stalenessThresholdMs = getStalenessThresholdMs(runtimeConfig, heartbeatMultiplier);

  /*
  FNXC:AgentHeartbeat 2026-07-15-18:00:
  A persisted but unparseable heartbeat cannot prove agent freshness. Treat it
  as Unresponsive rather than letting NaN bypass the elapsed-time comparison,
  matching the engine's persisted-heartbeat classification surfaces. Future
  timestamps clamp to zero so clock skew does not create a false stale label.
  */
  if (!Number.isFinite(lastHeartbeat)) {
    return {
      label: AGENT_HEALTH_LABEL_UNRESPONSIVE,
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
      reason: "Last heartbeat timestamp is invalid",
    };
  }

  /*
  FNXC:MobileTabDiscard 2026-07-26-10:16:
  Heartbeat freshness measures the heartbeat against the AGE OF THE AGENT RECORD, not wall-clock now.
  After a mobile tab discard the agents list hydrates from an SWR snapshot that can be hours old; aging
  its heartbeats against `Date.now()` labelled every healthy agent "Unresponsive" (and printed a
  fabricated "No heartbeat for 2h") until revalidation landed — seconds on a waking mobile radio. Same
  defect that made every in-progress card render "stuck"; see utils/dataFreshness.ts.
  `dataAsOfMs === undefined` keeps the previous `Date.now()` behavior for live data.
  */
  const elapsed = elapsedSinceMs(lastHeartbeat, dataAsOfMs);

  if (elapsed > stalenessThresholdMs) {
    const reason = `No heartbeat for ${formatDuration(elapsed)} (threshold: ${formatDuration(stalenessThresholdMs)})`;
    return {
      label: AGENT_HEALTH_LABEL_UNRESPONSIVE,
      icon: <Activity size={14} />,
      color: "var(--state-error-text)",
      stateDerived: false,
      reason,
    };
  }

  return {
    label: "Healthy",
    icon: <Heart size={14} />,
    color: "var(--state-active-text)",
    stateDerived: false,
  };
}

/**
 * Returns a CSS variable name for the health color.
 * Useful when you need the raw CSS variable name for custom styling.
 */
export function getAgentHealthColorVar(agent: AgentHealthInput, dataAsOfMs?: number): string {
  const status = getAgentHealthStatus(agent, 1, dataAsOfMs);
  // Extract the CSS variable name from the color string
  // e.g., "var(--state-error-text)" -> "--state-error-text"
  const match = status.color.match(/var\((--[^)]+)\)/);
  return match ? match[1] : status.color;
}
