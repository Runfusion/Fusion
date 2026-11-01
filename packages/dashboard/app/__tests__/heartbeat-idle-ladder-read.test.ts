/*
FNXC:HeartbeatIdleBackoff 2026-11-01-14:25 (RUFU-268):
THE IDLE LADDER IS ONLY SAFE IF THE SURFACES THAT READ IT AGREE WITH THE ENGINE THAT RAN IT.

RUFU-268 lets the engine hold a deliberately idle, unassigned agent at a longer wait than it was
configured for, up to a 30-minute ceiling. That makes every read side that measures an agent against its
CONFIGURED interval wrong on purpose: an agent silently doing exactly what the scheduler told it would be
labelled Unresponsive on the Agents list, and its manager's briefing would be told to go chase it.

Two claims keep this change honest, and the second is the one that stops the fix becoming a blind spot:
1. An agent the ladder is holding is not accused of being unresponsive during the silence it was granted.
2. An agent that is NOT idling is judged on exactly the arithmetic used before RUFU-268 — same multiplier,
   same floor, same seconds. A loosened threshold for everyone would hide a stopped agent, which is worse
   than the false accusation this task set out to remove.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentHealthStatus, getStalenessThresholdMs } from "../utils/agentHealth";
import { resolveHeartbeatCadenceMs, resolveHeartbeatIntervalMs } from "../utils/heartbeatIntervals";

const MINUTE = 60_000;
/*
The dashboard clamps a persisted interval up to `MIN_HEARTBEAT_INTERVAL_MS` (5 minutes) before any of this
arithmetic, so the fixtures below use a 5-minute cadence: a 1-minute fixture would silently assert against
a clamped 5-minute one, and the numbers would stop meaning what the sentences say.
*/
const BASE_MS = 5 * MINUTE;

function healthInput(runtimeConfig: Record<string, unknown>, lastHeartbeatAt: string | null) {
  return {
    state: "active" as const,
    lastHeartbeatAt,
    lastError: undefined,
    pauseReason: undefined,
    runtimeConfig: runtimeConfig as never,
    metadata: {},
    name: "Idle Ladder Agent",
    role: "executor" as const,
    taskId: undefined,
  };
}

describe("resolveHeartbeatCadenceMs — the forecast a countdown may be built from", () => {
  it("is the configured interval for every row the ladder has never touched", () => {
    // The shape of every agent row written before RUFU-268, and of every agent that never idled long
    // enough to earn a rung: the countdown must read exactly as it did before the ladder existed.
    for (const runtimeConfig of [
      { heartbeatIntervalMs: BASE_MS },
      { heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 0 },
      { heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: undefined },
    ]) {
      expect(resolveHeartbeatCadenceMs(runtimeConfig)).toBe(resolveHeartbeatIntervalMs(runtimeConfig.heartbeatIntervalMs));
    }
  });

  it("stretches only the rungs the engine actually granted, and stops at the ceiling", () => {
    expect(resolveHeartbeatCadenceMs({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 1 })).toBe(BASE_MS);
    expect(resolveHeartbeatCadenceMs({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 2 })).toBe(2 * BASE_MS);
    expect(resolveHeartbeatCadenceMs({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 3 })).toBe(4 * BASE_MS);
    // The ceiling is what makes the ladder safe to ship: a forecast that ran away with the streak would
    // tell an operator "next heartbeat: never".
    expect(resolveHeartbeatCadenceMs({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 4_000 })).toBe(30 * MINUTE);
  });

  it("falls back to the configured interval for a streak that is not a number", () => {
    // A corrupt row may cost an honest forecast, never a wild one.
    expect(resolveHeartbeatCadenceMs({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: "lots" })).toBe(BASE_MS);
    expect(resolveHeartbeatCadenceMs(undefined)).toBe(resolveHeartbeatIntervalMs(undefined));
  });
});

describe("every next-beat surface reads the cadence, and none of the interval controls do", () => {
  /*
  FNXC:HeartbeatIdleBackoff 2026-11-01-14:35 (RUFU-268):
  Four surfaces promised "next heartbeat" and each computed it from the CONFIGURED interval, so the fix had
  to land in all four or the symptom would survive in whichever one a per-file test forgot. A behaviour test
  per component would need four rendered trees and a fake clock each; what actually regresses here is a call
  site reverting to the other resolver, and that is a fact readable in the source. The interval DROP-DOWN is
  asserted in the same pass because its failure mode is the mirror image: a selector that started showing a
  cadence would offer the operator a setting the agent does not have.
  */
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("forecasts each agent's next beat from the ladder-aware cadence", () => {
    const surfaces = [
      "../components/AgentsView.tsx",
      "../components/ActiveAgentsPanel.tsx",
      "../components/AgentDetailView.tsx",
    ];
    for (const surface of surfaces) {
      expect(read(surface), surface).toContain("resolveHeartbeatCadenceMs");
    }
  });

  it("keeps the interval control on the configured interval", () => {
    const agentsView = read("../components/AgentsView.tsx");
    const optionsLine = agentsView.indexOf("getHeartbeatIntervalOptions(");
    const lineStart = agentsView.lastIndexOf("\n", optionsLine);
    const line = agentsView.slice(lineStart, agentsView.indexOf("\n", optionsLine));
    // The selector's input is the persisted setting, never the ladder: the dropdown edits a configuration,
    // not a forecast.
    expect(line).toContain("configuredIntervalMs");
    expect(line).not.toContain("Cadence");
    expect(agentsView.slice(lineStart - 400, optionsLine)).toContain("resolveHeartbeatIntervalMs");
  });
});

describe("the Agents-list and org-chart staleness pill", () => {
  it("does not call an idling agent Unresponsive while the ladder still owns its silence", async () => {
    const { AGENT_HEALTH_LABEL_UNRESPONSIVE } = await import("../utils/agentHealth");
    // streak 8 on a 5-minute cadence clamps to the 30-minute rung, so the unresponsive line sits at
    // 30 × 4 = 2 hours. Forty minutes of silence is therefore a wait the ENGINE chose, where the pill used
    // to accuse after 5 × 4 = 20 minutes.
    const idling = healthInput({ heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 8 }, new Date(Date.now() - 40 * MINUTE).toISOString());
    expect(getAgentHealthStatus(idling).label).not.toBe(AGENT_HEALTH_LABEL_UNRESPONSIVE);
  });

  it("still calls the same silence Unresponsive for an agent that is not idling", async () => {
    // The byte-identical half of the symptom: same 40 minutes, same cadence, no streak on the row. A
    // stopped agent must be labelled as fast as it is labelled today, or this fix would have bought a
    // calmer UI by hiding real failures.
    const { AGENT_HEALTH_LABEL_UNRESPONSIVE } = await import("../utils/agentHealth");
    const stalled = healthInput({ heartbeatIntervalMs: BASE_MS }, new Date(Date.now() - 40 * MINUTE).toISOString());
    expect(getAgentHealthStatus(stalled).label).toBe(AGENT_HEALTH_LABEL_UNRESPONSIVE);
  });

  it("keeps the non-idling threshold formula untouched", () => {
    // Written out as the pre-RUFU-268 expression rather than as a number borrowed from the implementation:
    // if the ladder-aware helper ever stopped honouring its "streak 0 = configured interval" contract,
    // this fails even if the implementation and the test were changed to agree with each other.
    expect(getStalenessThresholdMs({ heartbeatIntervalMs: BASE_MS })).toBe(Math.max(BASE_MS * 4, 5 * MINUTE));
  });

  it("stretches the pill's threshold by the rung the agent sits on, not by the ceiling", () => {
    // streak 3 on a one-minute cadence is a four-minute rung. A threshold that read the 30-minute ceiling
    // instead would have excused this agent's silence far past anything the engine granted it, which is
    // the difference between "stretch what the ladder decided" and "stop checking".
    const atRung = { heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 3 };
    const atCap = { heartbeatIntervalMs: BASE_MS, heartbeatIdleStreak: 9 };

    expect(getStalenessThresholdMs(atRung)).toBe(Math.max(4 * BASE_MS * 4, 5 * MINUTE));
    expect(getStalenessThresholdMs(atCap)).toBe(Math.max(30 * MINUTE * 4, 5 * MINUTE));
  });
});
