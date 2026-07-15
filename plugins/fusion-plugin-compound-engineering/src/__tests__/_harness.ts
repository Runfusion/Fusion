import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterAll, vi } from "vitest";
import { applySchemaBaseline, createAsyncDataLayer, createConnectionSetFromUrl, type AsyncDataLayer, type ResolvedBackend } from "@fusion/core";
import { PG_AVAILABLE, pgDescribe } from "@fusion/test-utils/pg-test-harness";
export { PG_AVAILABLE, pgDescribe };
import type {
  CreateInteractiveAiSessionFactory,
  InteractiveAiSession,
  InteractiveAiSessionEvent,
  PluginContext,
} from "@fusion/core";

export interface TestHarness {
  layer: AsyncDataLayer;
  projectRoot: string;
  ctx: PluginContext;
  emitted: Array<{ event: string; data: unknown }>;
  close(): void;
}

const dbName = `ce_harness_${process.pid}_${process.env.VITEST_POOL_ID ?? "0"}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9_]/g, "_");
let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;
let setupPromise: Promise<void> | null = null;
// FNXC:PgTestAuthFix 2026-07-14-07:40:
// The inline admin used process.env.USER for the psql -U flag, which is 'runner' on
// GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead.
function admin(statement: string): void { execSync(`psql "${process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432"}/postgres" -v ON_ERROR_STOP=1 -c "${statement}"`, { stdio: "pipe" }); }
async function setupPostgres(): Promise<void> {
  if (connections) return;
  admin(`DROP DATABASE IF EXISTS ${dbName}`); admin(`CREATE DATABASE ${dbName}`);
  const url = `${process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432"}/${dbName}`;
  const backend: ResolvedBackend = { mode: "external", runtimeUrl: url, migrationUrl: url, migrationUrlOverridden: false };
  const schema = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(schema.migration); await schema.close();
  connections = await createConnectionSetFromUrl(backend, { poolMax: 5, connectTimeoutSeconds: 5 });
}
afterAll(async () => {
  await connections?.close().catch(() => undefined);
  connections = null;
  if (!PG_AVAILABLE) return;
  try { admin(`DROP DATABASE IF EXISTS ${dbName}`); } catch { /* best effort */ }
});

/**
 * In-memory DB + a minimal route-style PluginContext whose `taskStore` exposes
 * `getDatabase()` / `getRootDir()` (the only surfaces the orchestrator uses) and
 * a recording `emitEvent` so tests can assert observable events.
 */
export async function makeHarness(): Promise<TestHarness> {
  setupPromise ??= setupPostgres();
  await setupPromise;
  const projectRoot = mkdtempSync(join(tmpdir(), "ce-session-test-"));
  const layer = createAsyncDataLayer(connections!, { projectId: `ce-test-${Math.random().toString(36).slice(2)}` });

  const emitted: Array<{ event: string; data: unknown }> = [];

  const taskStore = {
    getAsyncLayer: () => layer,
    isBackendMode: () => true,
    getRootDir: () => projectRoot,
  } as unknown as PluginContext["taskStore"];

  const ctx: PluginContext = {
    pluginId: "fusion-plugin-compound-engineering",
    taskStore,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  };

  return {
    layer,
    projectRoot,
    ctx,
    emitted,
    close: () => {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A scripted fake interactive session: each prompt/answer advances a cursor and
 * the next `nextEvent()` yields the scripted event for that turn. Mirrors the
 * U4 seam tests' scripted fake.
 */
export function makeScriptedSession(script: InteractiveAiSessionEvent[]): InteractiveAiSession {
  let cursor = -1;
  return {
    prompt: vi.fn(async () => {
      cursor++;
    }),
    answer: vi.fn(async () => {
      cursor++;
    }),
    nextEvent: vi.fn(async () => {
      if (script.length === 0) {
        // An empty script is a test bug — surface it loudly rather than
        // silently returning undefined (which masks the mistake downstream).
        throw new Error("makeScriptedSession: empty script has no events to yield");
      }
      return script[Math.min(Math.max(cursor, 0), script.length - 1)];
    }),
    dispose: vi.fn(),
  };
}

/** A factory that returns the given scripted session. */
export function scriptedFactory(session: InteractiveAiSession): CreateInteractiveAiSessionFactory {
  return vi.fn(async () => ({ session, sessionFile: "/tmp/ce.json" }));
}

/** A session whose first turn never produces an event (forces a turn timeout). */
export function hangingSession(): InteractiveAiSession {
  return {
    prompt: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    nextEvent: vi.fn(() => new Promise<InteractiveAiSessionEvent>(() => undefined)),
    dispose: vi.fn(),
  };
}
