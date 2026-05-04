import { vi } from "vitest";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";
import type { AgentSession } from "../agent-heartbeat.js";

export function createMockStore(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
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
