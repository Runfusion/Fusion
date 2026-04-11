// @vitest-environment node

import { EventEmitter } from "node:events";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateKbAgent } = vi.hoisted(() => ({
  mockCreateKbAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createKbAgent: mockCreateKbAgent,
}));

import type { AiSessionRow } from "./ai-session-store.js";
// @ts-expect-error Vite raw loader import for source-level utility tests
import subtaskBreakdownSource from "./subtask-breakdown.ts?raw";
import {
  __resetSubtaskBreakdownState,
  cancelSubtaskSession,
  cleanupSubtaskSession,
  createSubtaskSession,
  retrySubtaskSession,
  getSubtaskSession,
  rehydrateFromStore,
  SessionNotFoundError,
  InvalidSessionStateError,
  setAiSessionStore,
  SubtaskStreamManager,
} from "./subtask-breakdown.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InternalSubtaskFns = {
  parseSubtasks: (text: string) => Array<{
    id: string;
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[];
  }>;
  normalizeSubtaskItem: (
    item: Partial<{
      id: string;
      title: string;
      description: string;
      suggestedSize: "S" | "M" | "L" | "";
      dependsOn: unknown[];
    }>,
    index?: number,
  ) => {
    id: string;
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[];
  };
  generateFallbackSubtasks: (initialDescription: string) => Array<{
    id: string;
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    dependsOn: string[];
  }>;
};

function extractFunctionSource(startToken: string, endToken: string): string {
  const start = subtaskBreakdownSource.indexOf(startToken);
  if (start < 0) {
    throw new Error(`Unable to find function start token: ${startToken}`);
  }
  const end = subtaskBreakdownSource.indexOf(endToken, start);
  if (end < 0) {
    throw new Error(`Unable to find function end token: ${endToken}`);
  }
  return subtaskBreakdownSource.slice(start, end).trim();
}

async function loadInternalSubtaskFunctions(): Promise<InternalSubtaskFns> {
  const parseSource = extractFunctionSource(
    "function parseSubtasks",
    "\nfunction normalizeSubtaskItem",
  );
  const normalizeSource = extractFunctionSource(
    "function normalizeSubtaskItem",
    "\nfunction generateFallbackSubtasks",
  );
  const fallbackSource = extractFunctionSource(
    "function generateFallbackSubtasks",
    "\nfunction completeSession",
  );

  const utilityModuleSource = `
    type SubtaskItem = {
      id: string;
      title: string;
      description: string;
      suggestedSize: "S" | "M" | "L";
      dependsOn: string[];
    };

    ${parseSource}

    ${normalizeSource}

    ${fallbackSource}

    export { parseSubtasks, normalizeSubtaskItem, generateFallbackSubtasks };
  `;

  const transpiled = ts.transpileModule(utilityModuleSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
  return (await import(moduleUrl)) as InternalSubtaskFns;
}

let internalFns: InternalSubtaskFns;

function createMockSubtaskAgent(responseText?: string) {
  const messages: Array<{ role: string; content: string }> = [];
  const response =
    responseText ??
    JSON.stringify({
      subtasks: [
        {
          id: "subtask-1",
          title: "Define implementation approach",
          description: "Plan the implementation details",
          suggestedSize: "S",
          dependsOn: [],
        },
      ],
    });

  return {
    session: {
      state: { messages },
      prompt: vi.fn(async (message: string) => {
        messages.push({ role: "user", content: message });
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

class MockAiSessionStore extends EventEmitter {
  rows = new Map<string, AiSessionRow>();

  upsert(row: AiSessionRow): void {
    this.rows.set(row.id, row);
  }

  updateThinking(id: string, thinkingOutput: string): void {
    const row = this.rows.get(id);
    if (!row) {
      return;
    }

    this.rows.set(id, {
      ...row,
      thinkingOutput,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(id: string): void {
    this.rows.delete(id);
    this.emit("ai_session:deleted", id);
  }

  get(id: string): AiSessionRow | null {
    return this.rows.get(id) ?? null;
  }

  listRecoverable(): AiSessionRow[] {
    return [...this.rows.values()].filter(
      (row) => row.status === "awaiting_input" || row.status === "generating" || row.status === "error",
    );
  }

  on(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.on(event, listener);
  }

  off(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.off(event, listener);
  }
}

function buildSubtaskRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    type: overrides.type ?? "subtask",
    status: overrides.status,
    title: overrides.title ?? "Subtask breakdown",
    inputPayload:
      overrides.inputPayload ?? JSON.stringify({ initialDescription: "Break this task down" }),
    conversationHistory: overrides.conversationHistory ?? "[]",
    currentQuestion: overrides.currentQuestion ?? null,
    result:
      overrides.result ??
      JSON.stringify([
        {
          id: "subtask-1",
          title: "Define scope",
          description: "Plan the work",
          suggestedSize: "S",
          dependsOn: [],
        },
      ]),
    thinkingOutput: overrides.thinkingOutput ?? "thinking",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

beforeAll(async () => {
  internalFns = await loadInternalSubtaskFunctions();
});

beforeEach(() => {
  mockCreateKbAgent.mockReset();
  mockCreateKbAgent.mockImplementation(async () => createMockSubtaskAgent());
});

afterEach(() => {
  __resetSubtaskBreakdownState();
  vi.restoreAllMocks();
});

describe("SubtaskStreamManager", () => {
  it("subscribe/broadcast delivers events and unsubscribe stops delivery", () => {
    const manager = new SubtaskStreamManager();
    const callback = vi.fn();

    const unsubscribe = manager.subscribe("session-1", callback);

    manager.broadcast("session-1", { type: "thinking", data: "first delta" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      { type: "thinking", data: "first delta" },
      expect.any(Number),
    );

    unsubscribe();
    manager.broadcast("session-1", { type: "thinking", data: "second delta" });
    expect(callback).toHaveBeenCalledTimes(1);

    expect(() => manager.broadcast("missing-session", { type: "complete" })).not.toThrow();
  });

  it("cleanupSession removes subscribers and prior buffered events", () => {
    const manager = new SubtaskStreamManager();
    const callback = vi.fn();

    manager.subscribe("session-2", callback);
    manager.broadcast("session-2", { type: "thinking", data: "before cleanup" });

    expect(manager.getBufferedEvents("session-2", 0)).toHaveLength(1);

    manager.cleanupSession("session-2");

    manager.broadcast("session-2", { type: "thinking", data: "after cleanup" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(manager.getBufferedEvents("session-2", 0)).toEqual([
      { id: 1, event: "thinking", data: JSON.stringify("after cleanup") },
    ]);
  });

  it("notifies multiple subscribers and isolates subscriber errors", () => {
    const manager = new SubtaskStreamManager();
    const goodSubscriber = vi.fn();
    const throwingSubscriber = vi.fn(() => {
      throw new Error("subscriber failed");
    });

    manager.subscribe("session-3", throwingSubscriber);
    manager.subscribe("session-3", goodSubscriber);

    expect(() =>
      manager.broadcast("session-3", { type: "subtasks", data: [] }),
    ).not.toThrow();

    expect(throwingSubscriber).toHaveBeenCalledTimes(1);
    expect(goodSubscriber).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeSubtaskItem", () => {
  it("keeps valid items unchanged", () => {
    const result = internalFns.normalizeSubtaskItem(
      {
        id: "subtask-9",
        title: "Title",
        description: "Description",
        suggestedSize: "L",
        dependsOn: ["subtask-1"],
      },
      8,
    );

    expect(result).toEqual({
      id: "subtask-9",
      title: "Title",
      description: "Description",
      suggestedSize: "L",
      dependsOn: ["subtask-1"],
    });
  });

  it("fills default id, suggestedSize, and dependsOn when fields are missing", () => {
    const result = internalFns.normalizeSubtaskItem(
      {
        title: "  Plan  ",
        description: "  Work  ",
      },
      1,
    );

    expect(result).toEqual({
      id: "subtask-2",
      title: "Plan",
      description: "Work",
      suggestedSize: "M",
      dependsOn: [],
    });
  });

  it("defaults empty suggestedSize and filters non-string dependsOn entries", () => {
    const result = internalFns.normalizeSubtaskItem(
      {
        id: "",
        title: "Task",
        description: "Desc",
        suggestedSize: "",
        dependsOn: ["subtask-1", 123, null, "subtask-2"],
      },
      0,
    );

    expect(result.id).toBe("subtask-1");
    expect(result.suggestedSize).toBe("M");
    expect(result.dependsOn).toEqual(["subtask-1", "subtask-2"]);
  });
});

describe("parseSubtasks", () => {
  it("parses markdown-wrapped JSON and normalizes items", () => {
    const parsed = internalFns.parseSubtasks(`\`\`\`json\n{"subtasks":[{"title":"First"}]}\n\`\`\``);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "subtask-1",
      title: "First",
      description: "",
      suggestedSize: "M",
      dependsOn: [],
    });
  });

  it("parses raw JSON objects", () => {
    const parsed = internalFns.parseSubtasks(
      JSON.stringify({
        subtasks: [
          {
            id: "subtask-1",
            title: "First",
            description: "Do first",
            suggestedSize: "S",
            dependsOn: [],
          },
        ],
      }),
    );

    expect(parsed[0].title).toBe("First");
  });

  it("throws for invalid JSON, missing subtasks key, and empty subtasks array", () => {
    expect(() => internalFns.parseSubtasks("not-json")).toThrow();
    expect(() => internalFns.parseSubtasks(JSON.stringify({ foo: [] }))).toThrow(
      "AI did not return a valid subtasks array",
    );
    expect(() => internalFns.parseSubtasks(JSON.stringify({ subtasks: [] }))).toThrow(
      "AI did not return a valid subtasks array",
    );
  });
});

describe("generateFallbackSubtasks", () => {
  it("returns three sequential subtasks with expected dependency chain", () => {
    const description = "Implement a new dashboard flow";
    const subtasks = internalFns.generateFallbackSubtasks(description);

    expect(subtasks).toHaveLength(3);
    expect(subtasks[0]).toMatchObject({ id: "subtask-1", dependsOn: [] });
    expect(subtasks[1]).toMatchObject({ id: "subtask-2", dependsOn: ["subtask-1"] });
    expect(subtasks[2]).toMatchObject({ id: "subtask-3", dependsOn: ["subtask-2"] });
    expect(subtasks[0].description).toContain(description);

    for (const subtask of subtasks) {
      expect(["S", "M"]).toContain(subtask.suggestedSize);
    }
  });
});

describe("subtask session lifecycle", () => {
  it("createSubtaskSession returns generating session metadata", async () => {
    const description = "Build dashboard coverage tests for mission routes";

    const created = await createSubtaskSession(description);

    expect(created).toEqual({
      sessionId: expect.stringMatching(UUID_REGEX),
      initialDescription: description,
      subtasks: [],
      status: "generating",
      createdAt: expect.any(Date),
    });

    const inMemory = getSubtaskSession(created.sessionId);
    expect(inMemory).toBeDefined();
    expect(inMemory).toMatchObject({
      sessionId: created.sessionId,
      initialDescription: description,
      status: "generating",
      subtasks: [],
      createdAt: expect.any(Date),
    });
  });

  it("getSubtaskSession returns undefined for unknown session and public shape for known session", async () => {
    expect(getSubtaskSession("unknown-session")).toBeUndefined();

    const created = await createSubtaskSession("Public session shape verification");

    const session = getSubtaskSession(created.sessionId);
    expect(session).toBeDefined();
    expect(session).toMatchObject({
      sessionId: created.sessionId,
      initialDescription: "Public session shape verification",
      status: "generating",
      subtasks: [],
      createdAt: expect.any(Date),
    });
    expect(session).not.toHaveProperty("updatedAt");
    expect(session).not.toHaveProperty("agent");
    expect(session).not.toHaveProperty("thinkingOutput");
  });

  it("createSubtaskSession uses custom prompt from promptOverrides", async () => {
    const description = "Build test coverage for new API";
    const customPrompt = "Custom subtask prompt...";
    const promptOverrides = { "subtask-breakdown-system": customPrompt };

    const createKbAgentSpy = vi.fn().mockImplementation(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    }));
    mockCreateKbAgent.mockImplementation(createKbAgentSpy);

    const created = await createSubtaskSession(description, undefined, "/tmp/project", promptOverrides);

    // Wait for the session generation to complete
    await vi.waitFor(() => {
      const session = getSubtaskSession(created.sessionId);
      return session?.status === "complete";
    }, { timeout: 5000 });

    expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
    const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.systemPrompt).toBe(customPrompt);
  });

  it("createSubtaskSession falls back to default prompt when promptOverrides is undefined", async () => {
    const description = "Build test coverage for new API";

    const createKbAgentSpy = vi.fn().mockImplementation(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    }));
    mockCreateKbAgent.mockImplementation(createKbAgentSpy);

    const created = await createSubtaskSession(description, undefined, "/tmp/project");

    // Wait for the session generation to complete
    await vi.waitFor(() => {
      const session = getSubtaskSession(created.sessionId);
      return session?.status === "complete";
    }, { timeout: 5000 });

    expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
    const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.systemPrompt).toContain("task decomposition assistant");
  });

  it("createSubtaskSession falls back to default prompt when promptOverrides does not contain subtask key", async () => {
    const description = "Build test coverage for new API";
    const promptOverrides = { "planning-system": "Some other prompt" };

    const createKbAgentSpy = vi.fn().mockImplementation(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    }));
    mockCreateKbAgent.mockImplementation(createKbAgentSpy);

    const created = await createSubtaskSession(description, undefined, "/tmp/project", promptOverrides);

    // Wait for the session generation to complete
    await vi.waitFor(() => {
      const session = getSubtaskSession(created.sessionId);
      return session?.status === "complete";
    }, { timeout: 5000 });

    expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
    const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.systemPrompt).toContain("task decomposition assistant");
  });

  it("retrySubtaskSession retries errored sessions restored from SQLite", async () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({
      id: "subtask-retry-1",
      status: "error",
      error: "Transient failure",
      result: null,
    });
    store.rows.set(row.id, row);
    setAiSessionStore(store as any);

    await retrySubtaskSession(row.id, "/tmp/project");

    const session = getSubtaskSession(row.id);
    expect(session).toBeDefined();
    expect(session?.status).toBe("complete");
    expect(session?.subtasks.length).toBeGreaterThan(0);
    expect(store.get(row.id)?.status).toBe("complete");
    expect(store.get(row.id)?.error).toBeNull();
  });

  it("retrySubtaskSession rejects non-error sessions", async () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({ id: "subtask-retry-2", status: "generating" });
    store.rows.set(row.id, row);
    setAiSessionStore(store as any);

    await expect(retrySubtaskSession(row.id, "/tmp/project")).rejects.toBeInstanceOf(
      InvalidSessionStateError,
    );
  });

  it("retrySubtaskSession uses custom prompt from promptOverrides", async () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({
      id: "subtask-retry-with-override",
      status: "error",
      error: "Transient failure",
      result: null,
    });
    store.rows.set(row.id, row);
    setAiSessionStore(store as any);

    const customPrompt = "Custom subtask breakdown prompt...";
    const promptOverrides = { "subtask-breakdown-system": customPrompt };

    mockCreateKbAgent.mockReset();

    const createKbAgentSpy = vi.fn().mockImplementation(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    }));
    mockCreateKbAgent.mockImplementation(createKbAgentSpy);

    await retrySubtaskSession(row.id, "/tmp/project", promptOverrides);

    expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
    const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.systemPrompt).toBe(customPrompt);
  });

  it("retrySubtaskSession falls back to default prompt when promptOverrides is undefined", async () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({
      id: "subtask-retry-no-override",
      status: "error",
      error: "Transient failure",
      result: null,
    });
    store.rows.set(row.id, row);
    setAiSessionStore(store as any);

    mockCreateKbAgent.mockReset();

    const createKbAgentSpy = vi.fn().mockImplementation(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    }));
    mockCreateKbAgent.mockImplementation(createKbAgentSpy);

    await retrySubtaskSession(row.id, "/tmp/project");

    expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
    const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.systemPrompt).toContain("task decomposition assistant");
  });

  it("cancelSubtaskSession throws SessionNotFoundError for unknown session", async () => {
    await expect(cancelSubtaskSession("missing-session")).rejects.toMatchObject({
      name: "SessionNotFoundError",
    });
  });

  it("cancelSubtaskSession removes an existing session", async () => {
    const created = await createSubtaskSession("Cancel active session");

    await cancelSubtaskSession(created.sessionId);

    expect(getSubtaskSession(created.sessionId)).toBeUndefined();
  });

  it("cleanupSubtaskSession is idempotent", async () => {
    const created = await createSubtaskSession("Cleanup idempotency");

    expect(() => cleanupSubtaskSession(created.sessionId)).not.toThrow();
    expect(() => cleanupSubtaskSession(created.sessionId)).not.toThrow();
    expect(getSubtaskSession(created.sessionId)).toBeUndefined();
  });
});

describe("subtask session rehydration", () => {
  it("rehydrates recoverable subtask sessions from SQLite rows", () => {
    const store = new MockAiSessionStore();
    const subtaskRow = buildSubtaskRow({ id: "subtask-rehydrate-1", status: "generating" });
    const planningRow = buildSubtaskRow({
      id: "planning-rehydrate-1",
      status: "awaiting_input",
      type: "planning",
    });

    store.rows.set(subtaskRow.id, subtaskRow);
    store.rows.set(planningRow.id, planningRow);

    const rehydrated = rehydrateFromStore(store as any);

    expect(rehydrated).toBe(1);
    const session = getSubtaskSession(subtaskRow.id);
    expect(session).toBeDefined();
    expect(session?.sessionId).toBe(subtaskRow.id);
    expect(session?.initialDescription).toBe("Break this task down");
    expect(session?.status).toBe("generating");
    expect(session?.subtasks).toHaveLength(1);
    expect(getSubtaskSession(planningRow.id)).toBeUndefined();
  });

  it("skips corrupted rows and continues with valid rows", () => {
    const store = new MockAiSessionStore();
    const goodRow = buildSubtaskRow({ id: "subtask-good", status: "generating" });
    const badRow = buildSubtaskRow({
      id: "subtask-bad",
      status: "generating",
      inputPayload: "{bad-json",
    });

    store.rows.set(goodRow.id, goodRow);
    store.rows.set(badRow.id, badRow);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const rehydrated = rehydrateFromStore(store as any);

    expect(rehydrated).toBe(1);
    expect(getSubtaskSession(goodRow.id)).toBeDefined();
    expect(getSubtaskSession(badRow.id)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      `[subtask-breakdown] Failed to rehydrate session ${badRow.id}:`,
      expect.any(Error),
    );
  });

  it("falls through to SQLite when session is missing in memory", () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({ id: "subtask-fallthrough", status: "generating" });
    store.rows.set(row.id, row);
    setAiSessionStore(store as any);

    const session = getSubtaskSession(row.id);

    expect(session).toBeDefined();
    expect(session?.sessionId).toBe(row.id);
    expect(session?.initialDescription).toBe("Break this task down");
    expect(session?.status).toBe("generating");
  });

  it("returns in-memory session before SQLite fallback", () => {
    const store = new MockAiSessionStore();
    const row = buildSubtaskRow({ id: "subtask-memory-first", status: "generating" });
    store.rows.set(row.id, row);

    setAiSessionStore(store as any);
    rehydrateFromStore(store as any);

    store.rows.set(
      row.id,
      buildSubtaskRow({
        id: row.id,
        status: "generating",
        inputPayload: JSON.stringify({ initialDescription: "SQLite version" }),
      }),
    );

    const getSpy = vi.spyOn(store, "get");
    const session = getSubtaskSession(row.id);

    expect(session?.initialDescription).toBe("Break this task down");
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("SessionNotFoundError", () => {
  it("is an Error subtype with SessionNotFoundError name", () => {
    const error = new SessionNotFoundError("Missing session");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SessionNotFoundError");
    expect(error.message).toBe("Missing session");
  });
});
