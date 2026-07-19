/**
 * Canonical @fusion/core and @fusion/engine mock helpers for dashboard server tests.
 *
 * If a route test starts failing with "No \"X\" export is defined", update this
 * helper first instead of adding another full inline export map in the test file.
 */
import { vi, type Mock } from "vitest";

type AnyModule = Record<string, unknown>;
type AnyMock = Mock;

const fallbackFns = new Map<string, AnyMock>();

function getFallback(name: string): AnyMock {
  if (!fallbackFns.has(name)) fallbackFns.set(name, vi.fn());
  return fallbackFns.get(name)!;
}

function withFallbackFunctions(actual: AnyModule, moduleValue: AnyModule): AnyModule {
  return new Proxy(moduleValue, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (["then", "catch", "finally"].includes(prop)) return undefined;

      const actualValue = actual[prop];
      if (typeof actualValue === "function" || actualValue === undefined) {
        const fn = getFallback(prop);
        target[prop] = fn;
        return fn;
      }
      return actualValue;
    },
  });
}

export async function createCoreMock(
  importActual: () => Promise<AnyModule>,
  overrides: AnyModule = {},
): Promise<AnyModule> {
  const actual = await importActual();
  return withFallbackFunctions(actual, { ...actual, ...overrides });
}

export function createEngineMock(overrides: AnyModule = {}): AnyModule {
  const actual: AnyModule = {};
  return withFallbackFunctions(actual, {
    createFnAgent: vi.fn(),
    promptWithFallback: vi.fn(),
    /*
    FNXC:TestSkills 2026-06-17-19:33:
    Dashboard route tests mock @fusion/engine wholesale, so skill-aware planning lanes need a shaped session-skill helper result instead of the fallback vi.fn() returning undefined.
    */
    buildSessionSkillContextSync: vi.fn(() => ({
      skillSelectionContext: undefined,
      resolvedSkillNames: [],
      skillSource: "none" as const,
    })),
    // Returns an iterable tool list; dashboard code spreads its result
    // (`...createWorkflowAuthoringTools(...)`), so it must not be undefined.
    createWorkflowAuthoringTools: vi.fn(() => []),
    /*
    FNXC:DashboardRouteTests 2026-06-18-09:07:
    Planning and chat route files can share worker-level @fusion/engine mocks during broad dashboard API quality runs.
    Keep chat task document tools iterable by default so rescuing chat-routes from quarantine does not poison planning route imports with a fallback vi.fn() result.
    */
    createChatTaskDocumentTools: vi.fn(() => []),
    createChatArtifactTools: vi.fn(() => []),
    /*
    FNXC:MissingWorktreeRetry 2026-07-10-18:45:
    Dashboard route tests mock @fusion/engine wholesale; the retry route must still exercise the upstream #1992 classifier so merge-active unusable-worktree failures are admitted while unrelated merging rows remain rejected.
    */
    isInReviewMissingWorktreeSessionStartFailure: vi.fn((task: { column?: string; error?: unknown }) => (
      task.column === "in-review"
      && typeof task.error === "string"
      && (task.error.includes("Refusing to start coding agent in missing worktree:")
        || task.error.includes("Refusing to start coding agent in incomplete worktree:")
        || task.error.includes("Refusing to start coding agent in unregistered git worktree:"))
    )),
    // FNXC:McpConfig 2026-07-02-13:45: Planning/mission route tests share this engine mock; MCP resolution must return the full shaped empty result so readonly session creation can proceed without importing real engine stores.
    resolveMcpServersForStore: vi.fn(async () => ({ servers: [], errors: [] })),
    /*
    FNXC:TaskCreateDedup 2026-07-18-15:55:
    FN-8277 routes planning/subtask creation through createAgentTask. The wholesale
    @fusion/engine mock previously fell back to vi.fn() → undefined, so
    `const { task } = await createAgentTask(...)` threw. Default to a thin wrapper
    that uses the real store.createTask and reports wasDuplicate:false.
    */
    createAgentTask: vi.fn(async (
      store: { createTask?: (input: unknown, options?: unknown) => Promise<unknown> },
      input: unknown,
      _options?: unknown,
    ) => {
      if (typeof store?.createTask !== "function") {
        throw new Error("createAgentTask mock requires store.createTask");
      }
      const task = await store.createTask(input, { settings: {} });
      return { task, wasDuplicate: false };
    }),
    ...overrides,
  });
}

export function resetDashboardServerMockState(): void {
  for (const fn of fallbackFns.values()) fn.mockReset();
}
