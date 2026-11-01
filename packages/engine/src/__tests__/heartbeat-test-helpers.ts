import { vi } from "vitest";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";
import type { HeartbeatWakeCursor, WakeSignalSnapshot } from "../heartbeat-wake-signals.js";
import type { AgentSession } from "../agent-heartbeat.js";

export function createMockStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
    // Recovery reads run history for proof of life (STAS-308); an unspecified history is an empty
    // one, so the gate is served a real read instead of swallowing a missing-method error.
    getRecentRuns: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as AgentStore;
}

export function createMockSession(): AgentSession {
  return {
    dispose: vi.fn(),
  };
}

export function createMockMessageStore(onSetHook?: (hook: (message: Message) => void) => void): MessageStore {
  return {
    setMessageToAgentHook: vi.fn((hook: (message: Message) => void) => {
      onSetHook?.(hook);
    }),
  } as unknown as MessageStore;
}

export function createMessage(overrides: Partial<Message> = {}): Message {
  const now = new Date().toISOString();
  return {
    id: "msg-001",
    fromId: "user-1",
    fromType: "user",
    toId: "agent-1",
    toType: "agent",
    content: "hello",
    type: "user-to-agent",
    read: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createBudgetStatus(overrides: Partial<AgentBudgetStatus> = {}): AgentBudgetStatus {
  return {
    agentId: "agent-001",
    currentUsage: 0,
    budgetLimit: null,
    usagePercent: null,
    thresholdPercent: null,
    isOverBudget: false,
    isOverThreshold: false,
    lastResetAt: null,
    nextResetAt: null,
    ...overrides,
  };
}

export function createMockLogger() {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function formatMockError(err: unknown) {
  if (err instanceof Error) {
    const message = err.message || err.name || "Error";
    const stack = err.stack;
    return { message, stack, detail: stack ?? message };
  }
  const message = typeof err === "string" ? err : String(err);
  return { message, detail: message };
}

/**
 * The inbox contract a heartbeat run reads, in one fixture: the unread preview, the mailbox's
 * authoritative unread total, and consumption scoped to the ids that were actually surfaced.
 *
 * FNXC:HeartbeatWakeDiscipline 2026-10-13 (STAS-300): a fake that omits the unread total is not a
 * usable inbox store — the heartbeat has no number to print and reports the pending-message count
 * as unavailable instead of inventing one; a fake that omits scoped consumption cannot model what
 * a completed heartbeat owes the inbox.
 */
export function createInboxMessageStore(messages: Message[] = []) {
  const rows = messages.map((message) => ({ ...message }));
  const unread = () => rows.filter((message) => !message.read);

  return {
    setMessageToAgentHook: vi.fn(),
    getInbox: vi.fn((_ownerId: string, _ownerType: string, opts?: { read?: boolean; limit?: number }) => {
      const visible = opts?.read === false ? unread() : rows;
      return typeof opts?.limit === "number" ? visible.slice(0, opts.limit) : visible;
    }),
    getMailbox: vi.fn(() => ({ unreadCount: unread().length, messages: rows })),
    markInboxAsRead: vi.fn(async (_ownerId: string, _ownerType: string, messageIds: string[]) => {
      const consumed: string[] = [];
      for (const row of unread()) {
        if (messageIds.includes(row.id)) {
          row.read = true;
          consumed.push(row.id);
        }
      }
      return consumed;
    }),
  } as unknown as MessageStore & {
    getInbox: ReturnType<typeof vi.fn>;
    getMailbox: ReturnType<typeof vi.fn>;
    markInboxAsRead: ReturnType<typeof vi.fn>;
  };
}

/*
FNXC:HeartbeatIdleBackoff 2026-11-01-12:40 (RUFU-268):
The idle ladder is asserted from more than one suite — the gate/writer tests, the compact pre-flight's
session tests, and any later read-side check — and all of them need the same two facts: an unassigned
identity agent whose row carries a ladder, and an acknowledged completed run whose wake cursor covered a
given board. Duplicating that shape per file is how one suite would keep asserting the old field names
after the other had moved, so the fixtures live with the rest of the heartbeat harness.

Both are value-shape factories, not behaviour: what a ladder row HAS to contain is the contract, and the
suites that assert what the engine DOES with it should not each also be writing it.
*/
export const IDLE_LADDER_BASE_INTERVAL_MS = 5 * 60_000;

/**
 * An unassigned, identity-bearing agent idling on the ladder. `runtimeConfig` merges over the base
 * interval so a test that only cares about the streak never re-states a cadence, and
 * `{ heartbeatIdleStreak: undefined }` reproduces the row shape every agent had before RUFU-268.
 */
export function createIdleLadderAgent(
  runtimeConfig: Record<string, unknown> = {},
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: "agent-idle-1",
    name: "Idle Ladder Agent",
    role: "executor",
    state: "active",
    soul: "Monitor the project and pick up ambient work.",
    taskId: undefined,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    metadata: {},
    runtimeConfig: { heartbeatIntervalMs: IDLE_LADDER_BASE_INTERVAL_MS, ...runtimeConfig },
    ...overrides,
  } as unknown as Agent;
}

/**
 * A wake snapshot holding exactly the populations a test names, with the rest empty. The classifier
 * decision is about WHICH population moved, so a fixture that filled everything at once could not
 * distinguish them; each option stays `undefined`-able to mean "nothing in this population".
 */
export function createWakeSnapshot(options: {
  candidates?: string[];
  unread?: number;
  roomEntryIds?: string[];
  assignedRows?: string[];
  steeringCommentIds?: string[];
  assignedTaskState?: string | null;
} = {}): WakeSignalSnapshot {
  return {
    inboxUnreadTotal: options.unread ?? 0,
    roomEntryIds: options.roomEntryIds ?? [],
    boardState: {
      assignedTaskId: null,
      assignedTaskState: options.assignedTaskState ?? null,
      assignedRows: options.assignedRows ?? [],
      autoClaimCandidates: options.candidates ?? [],
      steeringCommentIds: options.steeringCommentIds ?? [],
    },
  };
}

/**
 * A wake cursor covering an empty board, for the classifier tests that vary ONE population at a time.
 * `overrides` patches the board state only — the shape of every population is the contract, and a fixture
 * that omitted one would test the classifier's tolerance for a malformed cursor instead of its taxonomy.
 */
export function createWakeCursor(boardState: Partial<HeartbeatWakeCursor["boardState"]> = {}): HeartbeatWakeCursor {
  return {
    consumedMessageIds: [],
    roomEntryIds: [],
    boardState: {
      assignedTaskId: null,
      assignedTaskState: null,
      assignedRows: [],
      autoClaimCandidates: [],
      steeringCommentIds: [],
      ...boardState,
    },
  };
}

/**
 * A completed run the wake gate accepts as an acknowledgement (`heartbeatDoneAccepted: true`) covering a
 * board whose auto-claim table held exactly `autoClaimCandidates`. Everything else in the cursor is
 * empty, so any candidate a test's snapshot reports is fresh by construction.
 */
export function createAcknowledgedHeartbeatRun(
  autoClaimCandidates: string[] = [],
  overrides: Partial<AgentHeartbeatRun> = {},
): AgentHeartbeatRun {
  return {
    id: "run-ack",
    agentId: "agent-idle-1",
    startedAt: "2026-10-31T06:00:00.000Z",
    endedAt: "2026-10-31T06:01:00.000Z",
    status: "completed",
    resultJson: {
      heartbeatDoneAccepted: true,
      wakeCursor: {
        consumedMessageIds: [],
        roomEntryIds: [],
        boardState: {
          assignedTaskId: null,
          assignedTaskState: null,
          assignedRows: [],
          autoClaimCandidates,
          steeringCommentIds: [],
        },
      },
    },
    ...overrides,
  } as unknown as AgentHeartbeatRun;
}
