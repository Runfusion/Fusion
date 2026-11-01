/*
FNXC:HeartbeatIdleBackoff 2026-10-31-23:54 (RUFU-268):
AN IDLE AGENT MUST NOT PAY FULL PRICE FOR DOING NOTHING.

Measured 2026-09-22 on a passive capture of the inference port: an unassigned agent's timer wake sent
its whole context — identity, soul, instructions, procedure, skills, the board dump, the candidate
table — on every tick, while the only possible answer to that briefing was "nothing to do". Ten minutes
of capture held 5 of 17 request pairs at ~0% prefix reuse from exactly these wakes, i.e. a permanent
cold pre-fill bleed of roughly 1-2k tokens/second of GPU time. STAS-300 later made a tick whose board
is provably unchanged cost zero sessions, but a tick that DOES carry a change still opened a full
session, and consecutive acknowledged no-work answers never stretched the interval at all.

This module is the cadence half of the fix: an acknowledged no-work heartbeat advances the agent's
idle streak, and the streak selects how long the scheduler may wait before it is allowed to deliver the
next timer tick — base → 2× → 4× → … clamped at the 30-minute ceiling the operator asked for, reset the
moment real work shows up.

Why this file is pure, dependency-free, and exported twice:
- The engine needs it to decide whether a tick may deliver, and the dashboard needs it to decide
  whether an agent that has legitimately not woken for 20 minutes is "Unresponsive". Two copies of that
  arithmetic are how a laddered agent gets accused by one surface while the other surface stays quiet,
  so there is exactly one function.
- `packages/dashboard/vite.config.ts` aliases `@fusion/core` to `packages/core/src/types.ts` so Node
  builtins cannot reach the browser bundle, and `core-types-browser-leaf.test.ts` refuses any value
  edge from that entry that reaches one. A module with zero imports is legal in that leaf by
  construction, which is why the ladder lives here rather than in the engine.
- Every input here is a value read back out of a persisted `agent.runtimeConfig` row written by an
  older build, a hand-edited row, or a future schema. Nothing may throw and nothing may overflow: a
  ladder that produced NaN would make every freshness threshold NaN, and an agent would disappear from
  health reporting entirely. Non-finite, negative, absent, or absurd streaks clamp to a defined answer.

Shape note: the ladder is deliberately its OWN state (`heartbeatIdleStreak` / `heartbeatLastNoWorkAt`),
not the RUFU-286 provider-throttle cooldown in `agents/heartbeat-recovery-state.ts`. That cooldown is
"do not re-probe a provider that rate-limited us"; this is "nothing on the board needs me". They share
only the exponential shape — reusing its fields would make a throttled agent look idle to the scheduler
and an idle agent look throttled to the operator.

@see packages/engine/src/agent-heartbeat.ts — the single writer (`recordAcknowledgedCompletion`) and the
     deferral gate inside `HeartbeatTriggerScheduler.onTimerTick`
@see packages/dashboard/app/utils/agentHealth.tsx — the read-side grace window
*/

/**
 * The ceiling of the idle ladder: 30 minutes, exactly what the operator specified ("5→10→20→30 min,
 * strop 30 min"). An idle agent's dispatch cadence never stretches past this, so new work is always
 * picked up within half an hour of appearing.
 */
export const HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS = 30 * 60_000;

/**
 * Highest streak the doubling loop will evaluate. The clamp exists so an absurd persisted value
 * (1e12, or a value an operator typed into a database cell) cannot spend the loop time or reach
 * floating-point overflow — the cap would win the comparison anyway, but the loop must terminate.
 */
const MAX_IDLE_LADDER_STEP = 40;

/** Inputs to the ladder step. Every field is untrusted persisted or settings data. */
export interface HeartbeatIdleDelayInput {
  /** `agent.runtimeConfig.heartbeatIdleStreak` — consecutive acknowledged no-work heartbeats. */
  streak: unknown;
  /** The agent's effective dispatch cadence (already scaled by `heartbeatMultiplier`). */
  baseIntervalMs: unknown;
  /** `settings.heartbeatIdleBackoffCapMs`; absent/invalid falls back to {@link HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS}. */
  capMs?: unknown;
}

/** Deferral inputs: the ladder step plus when the last acknowledged no-work heartbeat completed. */
export interface HeartbeatIdleDeferralInput extends HeartbeatIdleDelayInput {
  /** `agent.runtimeConfig.heartbeatLastNoWorkAt` — ISO timestamp of the last acknowledged no-work tick. */
  lastNoWorkAt: unknown;
  /** Wall clock now, in ms. A parameter rather than `Date.now()` so callers can drive it from fake timers. */
  nowMs: number;
}

/** Coerce a persisted/settings value to a usable positive duration, or 0 when it is not one. */
function positiveNumber(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

/**
 * Read a persisted streak as an integer step, or 0 ("not idling") for anything that is not a number.
 * Booleans are rejected rather than coerced: `Number(true)` is 1, which would silently place an agent
 * that got a stray `true` written into its JSON column onto the first rung of a ladder it never earned.
 */
function ladderStep(value: unknown): number {
  if (typeof value === "boolean" || value === null || value === undefined) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(Math.floor(numeric), 0), MAX_IDLE_LADDER_STEP);
}

/**
 * How long this agent's ladder says to wait between dispatches, in ms.
 *
 * `0` means "this agent is not idling" (absent or non-positive streak), which every caller must treat
 * as "no stretch at all" rather than "wait zero". A streak of 1 returns the base interval, so the very
 * first acknowledged no-work heartbeat costs the agent nothing extra — the ladder starts bending from
 * streak 2, which is what keeps "new work is caught within one base tick of the first idle answer" true.
 */
export function resolveHeartbeatIdleDelayMs(input: HeartbeatIdleDelayInput): number {
  const baseIntervalMs = positiveNumber(input.baseIntervalMs);
  if (baseIntervalMs === 0) return 0;

  const streak = ladderStep(input.streak);
  if (streak <= 1) return streak === 1 ? baseIntervalMs : 0;

  const capMs = positiveNumber(input.capMs) || HEARTBEAT_IDLE_BACKOFF_DEFAULT_CAP_MS;
  let delay = baseIntervalMs;
  for (let step = 1; step < streak; step += 1) {
    delay *= 2;
    if (delay >= capMs) return Math.min(delay, capMs);
  }
  return Math.min(delay, capMs);
}

/**
 * How long a timer tick must still wait before this idle agent may be dispatched, in ms.
 * `0` means dispatch now.
 *
 * `heartbeatLastNoWorkAt` is the anchor and it SLIDES: the writer re-stamps it on every acknowledged
 * no-work completion. Anchoring it at the episode start instead would make elapsed time grow without
 * bound, so from ladder step 2 onward every tick would already be past its own deadline and the
 * ladder would never bite again — the defect this function exists to prevent.
 *
 * A missing, unparseable, or future-dated anchor defers nothing. The rule is absolute: a bad timestamp
 * may cost an idle agent one extra session, never a missed dispatch, because a stuck deferral is
 * invisible to the operator while an extra heartbeat is not.
 */
export function resolveHeartbeatIdleDeferralMs(input: HeartbeatIdleDeferralInput): number {
  const delayMs = resolveHeartbeatIdleDelayMs(input);
  if (delayMs <= 0) return 0;

  const anchorMs = typeof input.lastNoWorkAt === "string" ? Date.parse(input.lastNoWorkAt) : Number.NaN;
  if (!Number.isFinite(anchorMs)) return 0;

  const elapsedMs = input.nowMs - anchorMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  const remainingMs = delayMs - elapsedMs;
  return remainingMs > 0 ? remainingMs : 0;
}

/**
 * The longest span for which this agent may legitimately show no `lastHeartbeatAt` progress — the
 * number every heartbeat-freshness check multiplies by its own grace factor.
 *
 * Read-side consumers MUST use this rather than the raw ladder delay: a non-idling agent gets back its
 * base interval byte-identically, which is the guarantee that today's Unresponsive timing for busy
 * agents does not move by a millisecond.
 */
export function resolveHeartbeatSilenceBudgetMs(input: HeartbeatIdleDelayInput): number {
  const baseIntervalMs = positiveNumber(input.baseIntervalMs);
  return Math.max(baseIntervalMs, resolveHeartbeatIdleDelayMs(input));
}
