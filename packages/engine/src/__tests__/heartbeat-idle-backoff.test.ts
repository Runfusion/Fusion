/*
FNXC:HeartbeatIdleBackoff 2026-11-01-01:35 (RUFU-268):
AN IDLE AGENT PAYS LIKE A CACHE READ, AND NOTHING ELSE CHANGES.

The claim under test is narrower than "backoff works". It is the two-sided one:

1. New work is still caught. A board delta older than the ceiling dispatches, a message or room entry
   dispatches immediately at any streak, and an agent that merely has an assignment never defers.
2. An agent idling on the ladder is not accused of being dead. Its grace window is stretched by its OWN
   step, and an agent that is not idling keeps the threshold it has always had, byte for byte.

Everything else here protects the shape of the persistence, because the ladder reads fields written by an
older build (`heartbeatIdleStreak` absent on every pre-RUFU-268 agent row) and by a row a human may have
edited. A ladder that mis-reads those is not slow, it is wrong in one of two directions: it either
spends sessions the operator asked it not to spend, or it silences an agent that should have been woken.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HeartbeatMonitor, HeartbeatTriggerScheduler } from "../agent-heartbeat.js";
import {
  createAcknowledgedHeartbeatRun,
  createIdleLadderAgent,
  createWakeSnapshot,
  IDLE_LADDER_BASE_INTERVAL_MS,
} from "./heartbeat-test-helpers.js";
import type { Agent, AgentHeartbeatRun, AgentStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { createLogger: vi.fn(() => quietLogger()), heartbeatLog: quietLogger(), formatError: formatMockError };
});

/*
The board probe is mocked at its module boundary, deliberately: `classifyFresherWakeSignal` stays REAL so
the gate is tested against a genuine classification, while the store walk behind the snapshot — auto-claim
retention, workflow-IR resolution, eligibility — belongs to `heartbeat-wake-signals.test.ts` and would
otherwise be re-tested here at the cost of a full board fake.
*/
vi.mock("../heartbeat-wake-signals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../heartbeat-wake-signals.js")>();
  return { ...actual, collectWakeSignals: vi.fn() };
});

import { collectWakeSignals } from "../heartbeat-wake-signals.js";

const mockedCollectWakeSignals = vi.mocked(collectWakeSignals);

const AGENT_ID = "agent-idle-1";
const BASE_MS = IDLE_LADDER_BASE_INTERVAL_MS;

interface GateHarness {
  monitor: HeartbeatMonitor;
  agent: Agent;
  updates: Record<string, unknown>[];
  audit: { mutationType: string; metadata?: Record<string, unknown> }[];
}

/**
 * The monitor with only the reads the wake gate and the writer actually make. The prior run is an
 * acknowledged one whose cursor covered an EMPTY board, so any candidate the snapshot reports is fresh.
 */
function gateHarness(options: {
  agent?: Agent;
  priorRun?: AgentHeartbeatRun | null;
  unreadCount?: number;
  candidates?: string[];
  assignedRows?: string[];
  steeringCommentIds?: string[];
  capMs?: number;
  nowMs?: number;
  boardReadFails?: boolean;
} = {}): GateHarness {
  const agent = options.agent ?? createIdleLadderAgent();
  const updates: Record<string, unknown>[] = [];
  const audit: { mutationType: string; metadata?: Record<string, unknown> }[] = [];

  mockedCollectWakeSignals.mockResolvedValue(createWakeSnapshot({
    candidates: options.candidates,
    unread: options.unreadCount,
    assignedRows: options.assignedRows,
    steeringCommentIds: options.steeringCommentIds,
  }) as never);

  const store = {
    getAgent: vi.fn().mockResolvedValue(agent),
    updateAgent: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return agent;
    }),
    getBudgetStatus: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue(options.priorRun === null ? [] : [options.priorRun ?? createAcknowledgedHeartbeatRun()]),
  } as unknown as AgentStore;

  const taskStore = {
    getSettings: vi.fn().mockResolvedValue(options.capMs === undefined ? {} : { heartbeatIdleBackoffCapMs: options.capMs }),
    getTasksByAssignedAgent: options.boardReadFails
      ? vi.fn().mockRejectedValue(new Error("store down"))
      : vi.fn().mockResolvedValue([]),
    recordRunAuditEvent: vi.fn(async (event: { mutationType: string; metadata?: Record<string, unknown> }) => {
      audit.push(event);
    }),
  } as unknown as TaskStore;

  const monitor = new HeartbeatMonitor({
    store,
    agentStore: store,
    taskStore,
    rootDir: process.cwd(),
    // Without this the monitor constructs a real AutoClaimSnapshotManager, whose snapshot walk needs the
    // whole board API. An empty snapshot is the same board the writer's cursor is asserted against.
    snapshotManager: { getSnapshot: vi.fn().mockResolvedValue({ tasks: [] }) } as never,
  } as never);

  return { monitor, agent, updates, audit };
}

describe("the idle ladder gate — new work is still caught", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defers a board-only delta that arrives inside this agent's own ladder step", async () => {
    const lastNoWorkAt = new Date(Date.now() - 60_000).toISOString();
    const h = gateHarness({
      agent: createIdleLadderAgent({ heartbeatIdleStreak: 3, heartbeatLastNoWorkAt: lastNoWorkAt }),
      candidates: ["FN-900"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toEqual({
      suppress: true,
      // streak 3 from a 5-minute base is a 20-minute wait, and only a minute has passed since the
      // acknowledged no-work heartbeat, so the remainder is what the tick must still wait.
      reason: expect.stringMatching(/^idle-backoff:/),
    });
  });

  it("dispatches a board-only delta once that agent's step has elapsed", async () => {
    const h = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 3,
        heartbeatLastNoWorkAt: new Date(Date.now() - 21 * 60_000).toISOString(),
      }),
      candidates: ["FN-900"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toEqual({
      suppress: false,
      reason: "fresher-signal",
      fresherSignal: "board-candidates",
    });
  });

  it("never defers past the ceiling, however long the idle episode has run", async () => {
    const h = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 4_000,
        heartbeatLastNoWorkAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
      candidates: ["FN-900"],
    });

    const decision = await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS });
    expect(decision.suppress).toBe(false);
  });

  it("dispatches a message immediately at any streak — arriving content is not a candidate reshuffle", async () => {
    const h = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 12,
        heartbeatLastNoWorkAt: new Date().toISOString(),
      }),
      unreadCount: 1,
      candidates: ["FN-900"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({
      suppress: false,
      fresherSignal: "messages",
    });
  });

  it("never defers a new steering comment on an assigned row, at any streak", async () => {
    // A steering comment is TEXT the agent has never read. The compact turn is never shown it, so a label
    // that let this be deferred would also let it be answered by a question that cannot see it.
    const h = gateHarness({
      agent: createIdleLadderAgent({ heartbeatIdleStreak: 12, heartbeatLastNoWorkAt: new Date().toISOString() }),
      steeringCommentIds: ["SC-NEW"],
      candidates: ["FN-900"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({
      suppress: false,
      fresherSignal: "board-content",
    });
  });

  it("never defers a change in the agent's own assigned rows — that is work landing on it", async () => {
    const h = gateHarness({
      agent: createIdleLadderAgent({ heartbeatIdleStreak: 12, heartbeatLastNoWorkAt: new Date().toISOString() }),
      assignedRows: ["FN-903:todo"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({
      suppress: false,
      fresherSignal: "board-assignment",
    });
  });

  it("defers nothing when the persisted anchor is absent, unparseable, or in the future", async () => {
    // Three shapes of a corrupt or rolled-back row. Each must cost the agent at most one session, never a
    // wait: a stuck deferral is invisible to the operator while an extra heartbeat is not.
    for (const lastNoWorkAt of [undefined, "not-a-date", new Date(Date.now() + 3_600_000).toISOString()]) {
      const h = gateHarness({
        agent: createIdleLadderAgent({ heartbeatIdleStreak: 12, heartbeatLastNoWorkAt: lastNoWorkAt }),
        candidates: ["FN-900"],
      });
      expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({
        suppress: false,
        fresherSignal: "board-candidates",
      });
    }
  });

  it("defers nothing for a streak that is not a number", async () => {
    // `Number(true)` is 1, so a boolean coerced rather than rejected would put an agent that never idled
    // (a hand-edited row) onto the first rung of a ladder it did not earn.
    for (const streak of [true, "twelve", null, 0, -4]) {
      const h = gateHarness({
        agent: createIdleLadderAgent({ heartbeatIdleStreak: streak, heartbeatLastNoWorkAt: new Date().toISOString() }),
        candidates: ["FN-900"],
      });
      expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({ suppress: false });
    }
  });

  it("bends a streak-1 tick to the base interval and no further", async () => {
    // The first rung of the ladder IS the configured interval: "1×" in the ladder's spec. So a tick that
    // arrives a full interval after the acknowledged no-work heartbeat is already at its deadline, and one
    // that arrives immediately is held no longer than that same interval. Both halves matter — the first is
    // why a first idle answer cannot push real work past the ceiling, the second is why a stray extra tick
    // cannot re-probe the board twice inside one interval.
    const anchorMs = Date.UTC(2026, 10, 1, 12, 0, 0);
    const fresh = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 1,
        heartbeatLastNoWorkAt: new Date(anchorMs).toISOString(),
      }),
      candidates: ["FN-900"],
    });
    // A pinned `nowMs` rather than a live clock: the assertion is about the exact rung the ladder sits on,
    // and an anchor built a millisecond before the call would answer `299999`.
    expect(await fresh.monitor.decideTimerWake(fresh.agent, { intervalMs: BASE_MS, nowMs: anchorMs })).toMatchObject({
      suppress: true,
      reason: `idle-backoff:${BASE_MS}`,
    });

    const due = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 1,
        heartbeatLastNoWorkAt: new Date(anchorMs).toISOString(),
      }),
      candidates: ["FN-900"],
    });
    expect(await due.monitor.decideTimerWake(due.agent, { intervalMs: BASE_MS, nowMs: anchorMs + BASE_MS }))
      .toMatchObject({ suppress: false });
  });

  it("never defers for an agent that has an assignment", async () => {
    const h = gateHarness({
      agent: createIdleLadderAgent({ heartbeatIdleStreak: 12, heartbeatLastNoWorkAt: new Date().toISOString() }, {
        taskId: "FN-901",
      }),
      candidates: ["FN-900"],
    });

    expect(await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).toMatchObject({ suppress: false });
  });

  it("honours an operator-lowered ceiling", async () => {
    // streak 12 would reach the 30-minute default; a 2-minute cap must release the tick after 2 minutes.
    const h = gateHarness({
      agent: createIdleLadderAgent({
        heartbeatIdleStreak: 12,
        heartbeatLastNoWorkAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      candidates: ["FN-900"],
      capMs: 2 * 60_000,
    });

    expect((await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS })).suppress).toBe(false);
  });

  it("defers nothing for an agent whose row predates the ladder", async () => {
    const h = gateHarness({ agent: createIdleLadderAgent(), candidates: ["FN-900"] });
    const decision = await h.monitor.decideTimerWake(h.agent, { intervalMs: BASE_MS });
    expect(decision).toMatchObject({ suppress: false, fresherSignal: "board-candidates" });
  });
});

interface AckWriter {
  recordAcknowledgedCompletion(args: {
    agent: Agent;
    runId: string;
    foundWork: boolean;
    consumedMessageIds?: string[];
    roomEntryIds?: string[];
    withWakeCursor?: boolean;
  }): Promise<{ heartbeatDoneAccepted?: boolean; wakeCursor?: unknown }>;
}

/** The streak writer is private by design; a test reaches it through the seam, not through a new public API. */
function ackWriter(monitor: HeartbeatMonitor): AckWriter {
  return monitor as unknown as AckWriter;
}

describe("recordAcknowledgedCompletion — the one writer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("advances the streak and slides the anchor on an acknowledged no-work completion", async () => {
    const priorAt = new Date(Date.now() - 90_000).toISOString();
    const h = gateHarness({ agent: createIdleLadderAgent({ heartbeatIdleStreak: 2, heartbeatLastNoWorkAt: priorAt }) });

    const acknowledgement = await ackWriter(h.monitor).recordAcknowledgedCompletion({
      agent: h.agent,
      runId: "run-1",
      foundWork: false,
      consumedMessageIds: [],
      roomEntryIds: [],
    });

    expect(acknowledgement.heartbeatDoneAccepted).toBe(true);
    expect(acknowledgement.wakeCursor).toBeDefined();
    expect(h.updates).toHaveLength(1);
    const runtimeConfig = h.updates[0].runtimeConfig as Record<string, unknown>;
    expect(runtimeConfig.heartbeatIdleStreak).toBe(3);
    // The anchor SLIDES: anchored at the episode start, elapsed time only grows and the ladder stops biting.
    expect(Date.parse(String(runtimeConfig.heartbeatLastNoWorkAt))).toBeGreaterThan(Date.parse(priorAt));
    expect(h.audit.map((event) => event.mutationType)).toEqual(["agent:heartbeat-idle-ladder"]);
    expect(h.audit[0].metadata).toMatchObject({ outcome: "advanced", priorStreak: 2, streak: 3, stepMs: 20 * 60_000 });
  });

  it("clears both ladder keys when the acknowledged run found work", async () => {
    const h = gateHarness({ agent: createIdleLadderAgent({ heartbeatIdleStreak: 7, heartbeatLastNoWorkAt: new Date().toISOString() }) });

    await ackWriter(h.monitor).recordAcknowledgedCompletion({ agent: h.agent, runId: "run-2", foundWork: true });

    const runtimeConfig = h.updates[0].runtimeConfig as Record<string, unknown>;
    expect(runtimeConfig).not.toHaveProperty("heartbeatIdleStreak");
    expect(runtimeConfig).not.toHaveProperty("heartbeatLastNoWorkAt");
    expect(h.audit[0].metadata).toMatchObject({ outcome: "cleared", priorStreak: 7, streak: 0, stepMs: 0 });
  });

  it("writes neither a cursor nor a ladder advance when the board read fails", async () => {
    const h = gateHarness({ agent: createIdleLadderAgent({ heartbeatIdleStreak: 1 }), boardReadFails: true });
    // A run that cannot read the board has nothing to prove its silence against, so it may not buy a wait.

    const acknowledgement = await ackWriter(h.monitor).recordAcknowledgedCompletion({
      agent: h.agent,
      runId: "run-3",
      foundWork: false,
    });

    expect(acknowledgement.heartbeatDoneAccepted).toBeUndefined();
    expect(acknowledgement.wakeCursor).toBeUndefined();
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("writes nothing for a task heartbeat that had no ladder to clear", async () => {
    const h = gateHarness({ agent: createIdleLadderAgent() });
    await ackWriter(h.monitor).recordAcknowledgedCompletion({ agent: h.agent, runId: "run-4", foundWork: true, withWakeCursor: false });
    expect(h.updates).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("is the only production writer of the streak", async () => {
    const source = readFileSync(new URL("../agent-heartbeat.ts", import.meta.url), "utf8");
    const writers = source.split("\n").filter((line) => /runtimeConfig\.heartbeatIdleStreak\s*=/.test(line));
    // A second write site would let the streak and the wake cursor disagree about the same run.
    expect(writers).toHaveLength(1);
    expect(source).toContain("delete runtimeConfig.heartbeatIdleStreak");
    expect(source).toContain("delete runtimeConfig.heartbeatLastNoWorkAt");
  });
});

describe("HeartbeatTriggerScheduler — a deferred tick is still a live tick", () => {
  function schedulerFor(decide: (agent: Agent, context?: { intervalMs?: number }) => Promise<{ suppress: boolean; reason?: string }>) {
    const agent = createIdleLadderAgent();
    const store = {
      getAgent: vi.fn().mockResolvedValue(agent),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    } as unknown as AgentStore;
    const callback = vi.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatTriggerScheduler(store, callback, undefined, { shouldSuppressTimerWake: decide });
    (scheduler as unknown as { running: boolean }).running = true;
    const timers = (scheduler as unknown as { lastTimerFireAtMs: Map<string, number> }).lastTimerFireAtMs;
    return { agent, callback, timers, tick: () => (scheduler as unknown as {
      onTimerTick: (id: string, ms: number) => Promise<void>;
    }).onTimerTick(agent.id, BASE_MS) };
  }

  it("does not dispatch a deferred tick, but still stamps the timer as alive", async () => {
    const { agent, callback, tick, timers } = schedulerFor(async () => ({ suppress: true, reason: "idle-backoff:1200000" }));
    await tick();
    expect(callback).not.toHaveBeenCalled();
    // The stamp is what keeps a deferred agent from being re-armed as a dead "zombie" timer — a wait the
    // scheduler owns must look alive to every other reader, or deferral is indistinguishable from a stall.
    expect(timers.get(agent.id)).toBeTypeOf("number");
  });

  it("forwards the gate's classification so the run may ask the cheap question", async () => {
    const { callback, tick } = schedulerFor(async () => ({ suppress: false, reason: "fresher-signal", fresherSignal: "board-candidates" }));
    await tick();
    expect(callback).toHaveBeenCalledWith(expect.any(String), "timer", expect.objectContaining({
      wakeReason: "timer",
      fresherSignal: "board-candidates",
    }));
  });

  it("carries no classification for an unclassified tick, so the full path is taken", async () => {
    const { callback, tick } = schedulerFor(async () => ({ suppress: false, reason: "probe-failed" }));
    await tick();
    const context = callback.mock.calls[0][2] as Record<string, unknown>;
    expect(context).not.toHaveProperty("fresherSignal");
  });

  it("asks the gate with the interval it is actually scheduling", async () => {
    const decide = vi.fn().mockResolvedValue({ suppress: false });
    const { tick } = schedulerFor(decide);
    await tick();
    expect(decide).toHaveBeenCalledWith(expect.anything(), { intervalMs: BASE_MS });
  });
});


describe("the reports-health section — the manager's stale arithmetic is ladder-aware", () => {
  const MINUTE = 60_000;

  /**
   * Renders the manager's briefing for one report row. The seam is the section's own signature — the
   * arithmetic under test is the threshold, so the harness supplies exactly the row and the settings.
   */
  async function reportsHealthRow(report: Record<string, unknown>, settings: Record<string, unknown> = {}): Promise<string> {
    const agentStore = {
      getAgentsByReportsTo: vi.fn().mockResolvedValue([report]),
      getAgent: vi.fn().mockResolvedValue(report),
    } as unknown as AgentStore;
    const taskStore = { getSettings: vi.fn().mockResolvedValue(settings) } as unknown as TaskStore;
    const monitor = new HeartbeatMonitor({ store: agentStore, agentStore, taskStore, rootDir: process.cwd() } as never);
    const section = await (monitor as unknown as {
      buildReportsHealthSection(agentId: string, store: AgentStore): Promise<string | null>;
    }).buildReportsHealthSection("manager-1", agentStore);
    return section ?? "";
  }

  function ladderedReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "agent-idle-1",
      name: "Laddered Report",
      state: "active",
      taskId: null,
      lastHeartbeatAt: new Date(Date.now() - 35 * MINUTE).toISOString(),
      runtimeConfig: { heartbeatIntervalMs: 60_000, heartbeatIdleStreak: 8 },
      ...overrides,
    };
  }

  it("does not call a laddered report stale inside its own explained silence", async () => {
    // streak 8 on a 60-second cadence clamps to the 30-minute ceiling, so the stale line sits at 45 minutes.
    // Thirty-five minutes of silence is therefore EXPLAINED by the ladder and the manager must not be told
    // to chase it — which is the point: the briefing is the one surface that would otherwise accuse an
    // agent the scheduler is deliberately leaving alone.
    const section = await reportsHealthRow(ladderedReport());

    expect(section).toContain("Laddered Report");
    expect(section).not.toContain("**stale**");
    expect(section).not.toContain("For **stale** reports");
  });

  it("still calls the identical silence stale for a report that is not idling", async () => {
    // The byte-identical non-idling case: same clock, same cadence, no streak on the row. A genuinely
    // stalled agent reaches the manager's prompt exactly as loudly as it did before RUFU-268.
    const section = await reportsHealthRow(ladderedReport({
      id: "agent-stalled-1",
      name: "Stalled Report",
      runtimeConfig: { heartbeatIntervalMs: 60_000 },
    }));

    expect(section).toContain("**stale**");
    expect(section).toContain("For **stale** reports");
  });

  it("stretches by the rung the report actually sits on, not by the ceiling it has not reached", async () => {
    // Five-minute cadence at streak 2 is a ten-minute rung, so the stale line sits at 15 minutes and twenty
    // minutes of silence is unexplained. Reading the 30-minute CAP instead of the current rung would have
    // excused this genuine stall, which is the difference between "stretch what the ladder decided" and
    // "stop checking". The same twenty minutes at a capped rung IS explained, and both halves are asserted
    // so this test cannot pass by loosening the threshold for everyone.
    const silent = new Date(Date.now() - 20 * MINUTE).toISOString();
    const atRung = await reportsHealthRow(ladderedReport({ lastHeartbeatAt: silent, runtimeConfig: { heartbeatIntervalMs: 5 * MINUTE, heartbeatIdleStreak: 2 } }));
    const atCap = await reportsHealthRow(ladderedReport({ lastHeartbeatAt: silent, runtimeConfig: { heartbeatIntervalMs: 5 * MINUTE, heartbeatIdleStreak: 8 } }));

    expect(atRung).toContain("**stale**");
    expect(atCap).not.toContain("**stale**");
  });

  it("honours an operator-lowered ceiling in the manager's arithmetic too", async () => {
    // The scheduler and the briefing read the ceiling through one helper precisely so they cannot disagree
    // about how long an agent may be silent. Twelve minutes of silence at a long streak is explained by a
    // 30-minute ceiling and unexplained by a 2-minute one; a briefing that ignored the setting would read
    // the same twelve minutes as explained either way, and the manager would keep nagging past a tightening.
    const report = ladderedReport({
      lastHeartbeatAt: new Date(Date.now() - 12 * MINUTE).toISOString(),
      runtimeConfig: { heartbeatIntervalMs: 60_000, heartbeatIdleStreak: 8 },
    });

    expect(await reportsHealthRow(report)).not.toContain("**stale**");
    expect(await reportsHealthRow(report, { heartbeatIdleBackoffCapMs: 2 * MINUTE })).toContain("**stale**");
  });
});

describe("the two timer-tick wiring sites stay identical", () => {
  /*
  FNXC:HeartbeatIdleBackoff 2026-11-01-14:45 (RUFU-268):
  A timer tick reaches `executeHeartbeat` through exactly two construction sites — the in-process runtime
  and the UI-only dashboard scheduler. The idle ladder and the compact pre-flight both depend on what
  those sites forward (the effective interval, and the gate's signal classification), and a ladder wired
  to one and not the other is a bug no behaviour test in this file can see, because both sites are outside
  the monitor. Read as text, because the alternative is booting two engines to assert what a grep answers
  exactly.
  */
  const sites = [
    new URL("../runtimes/in-process-runtime.ts", import.meta.url),
    // The CLI file is the UI-only scheduler; it is not importable from the engine package, so it is read
    // from the repo root rather than resolved as a module.
    new URL("../../../cli/src/commands/dashboard.ts", import.meta.url),
  ];

  it("forwards the effective interval the gate must measure against", () => {
    for (const site of sites) {
      const source = readFileSync(site, "utf8");
      expect(source, site.pathname).toContain("decideTimerWake");
      expect(source, site.pathname).toContain("intervalMs: context?.intervalMs");
    }
  });

  it("forwards the gate's signal classification through the shared narrowing", () => {
    for (const site of sites) {
      const source = readFileSync(site, "utf8");
      // Not a copied literal union: both sites must narrow through `asWakeSignalKind`, so a kind added to
      // the classifier cannot be admitted at one site and silently dropped at the other.
      expect(source, site.pathname).toContain("fresherSignal: asWakeSignalKind(context.fresherSignal)");
    }
  });
});

describe("hasRecentDurableOwnerHeartbeat — deliberately NOT ladder-aware", () => {
  it("never consults the idle ladder, because its subject always owns a task", () => {
    const source = readFileSync(new URL("../self-healing.ts", import.meta.url), "utf8");
    const start = source.indexOf("function hasRecentDurableOwnerHeartbeat");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(start).toBeGreaterThan(-1);
    // A ladder-aware owner check would excuse an agent that stopped heartbeating while HOLDING a card.
    expect(body).not.toContain("heartbeatIdleStreak");
    expect(body).not.toContain("resolveHeartbeatSilenceBudgetMs");
  });
});
