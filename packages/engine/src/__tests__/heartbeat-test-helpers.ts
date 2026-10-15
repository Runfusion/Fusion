import { vi } from "vitest";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";
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
