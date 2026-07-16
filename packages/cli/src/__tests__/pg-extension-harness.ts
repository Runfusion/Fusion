/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Reusable PostgreSQL fixture + typed mocks for CLI extension (agent-tool) tests.
 *
 * The CLI extension's agent tools resolve their store via `getStore(cwd)`, which
 * the SQLite→PostgreSQL cutover rewired to boot the backend through
 * `createTaskStoreForBackend`. These tests can no longer construct a legacy
 * SQLite `new TaskStore(rootDir)` — that runtime was removed (VAL-REMOVAL-005).
 *
 * This harness reuses core's `createSharedPgTaskStoreTestHarness` (one isolated
 * PG database per describe block, truncated between tests) and injects the
 * resulting store into the extension's per-root cache via
 * `__setCachedStoreForTesting`, so every tool call for the harness rootDir
 * resolves to the SAME PostgreSQL-backed store the test seeds against. No
 * embedded PostgreSQL is started in the test process — the shared external test
 * server (localhost:5432, or FUSION_PG_TEST_URL_BASE) is used, and the whole
 * describe is skipped when PostgreSQL is unreachable (pgDescribe contract).
 *
 * Assert against task state through `store().getTask(id, { includeDeleted: true })`
 * — it returns `deletedAt` and `allowResurrection` for soft-deleted rows in
 * backend mode, so no raw drizzle handle is needed at the CLI layer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import kbExtension, {
  __setCachedStoreForTesting,
  closeCachedStores,
} from "../extension.js";
import type { TaskStore } from "@fusion/core";

export { pgDescribe };

/** One text content part of a fusion tool result. */
export interface ToolResultContent {
  type: "text";
  text: string;
}

/** The shape every fusion agent tool resolves to. */
export interface ToolResult {
  content: ToolResultContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** Context handed to every registered tool's execute callback. */
export interface ToolExecuteContext {
  cwd: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
}

/** A registered agent tool, as the mock API stores it. */
export interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolExecuteContext,
  ) => Promise<ToolResult>;
}

/** Minimal in-process mock of the pi ExtensionAPI registration surface. */
export interface MockApi {
  readonly tools: Map<string, RegisteredTool>;
  registerTool(tool: RegisteredTool): void;
  registerCommand(): void;
  on(): void;
}

/** Build a mock ExtensionAPI that records registered tools in a Map. */
export function createMockApi(): MockApi {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {
      // no-op for tests
    },
    on() {
      // no-op for tests
    },
  };
}

/**
 * Hand a {@link MockApi} to the extension. The mock only implements the tool-
 * registration surface, so it is cast once at this library boundary (the pi
 * ExtensionAPI type is far broader than the registration calls exercised here).
 */
export function registerExtension(api: MockApi): void {
  kbExtension(api as unknown as ExtensionAPI);
}

export interface PgExtensionHarness {
  /** The project rootDir the PG-backed store is scoped to (also the tool-call cwd). */
  readonly rootDir: () => string;
  /** The shared PostgreSQL-backed TaskStore (seed + assert against this). */
  readonly store: () => TaskStore;
  /** Vitest lifecycle hooks; wire them with beforeAll/beforeEach/afterEach/afterAll. */
  readonly beforeAll: () => Promise<void>;
  readonly beforeEach: () => Promise<void>;
  readonly afterEach: () => Promise<void>;
  readonly afterAll: () => Promise<void>;
}

/**
 * Build a CLI extension test harness backed by an isolated PostgreSQL database.
 * The store is injected into the extension cache so `getStore(rootDir)` returns
 * it for every tool call. `closeCachedStores()` runs in afterEach so injected
 * entries never leak across tests.
 */
export function createPgExtensionHarness(prefix: string): PgExtensionHarness {
  const pg = createSharedPgTaskStoreTestHarness({ prefix });
  return {
    rootDir: pg.rootDir,
    store: pg.store,
    beforeAll: pg.beforeAll,
    beforeEach: async () => {
      await pg.beforeEach();
      __setCachedStoreForTesting(pg.rootDir(), pg.store());
    },
    afterEach: async () => {
      await closeCachedStores();
      await pg.afterEach();
    },
    afterAll: pg.afterAll,
  };
}

/** Look up a registered tool, failing the test loudly if it was never registered. */
export function requireTool(api: MockApi, name: string): RegisteredTool {
  const tool = api.tools.get(name);
  if (!tool) throw new Error(`extension did not register tool "${name}"`);
  return tool;
}
