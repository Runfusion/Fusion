import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync, exec } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_SETTINGS, TaskStore, type Settings, type Task,
  type AsyncDataLayer, type ResolvedBackend,
  createConnectionSetFromUrl, applySchemaBaseline, createAsyncDataLayer,
} from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";

export const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;

export function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function reliabilityTestTempParent(): string {
  /*
  FNXC:ReliabilityFixtures 2026-06-20-21:24:
  FN-6817 traced merge-reuse-task-worktree flakes to reliability fixtures escaping the per-invocation Vitest worker root.
  Keep project roots and their `-worktrees` siblings under FUSION_TEST_WORKER_ROOT so concurrent package lanes and teardown cannot collide through the shared OS temp root.
  */
  return process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
}

function assertInitializedGitRepository(rootDir: string): void {
  const insideWorkTree = git(rootDir, "git rev-parse --is-inside-work-tree");
  if (insideWorkTree !== "true") {
    throw new Error(`Reliability fixture git init did not create a usable repository at ${rootDir}`);
  }
}

/*
FNXC:SqliteRemoval 2026-07-14-00:00:
The SQLite Database class was removed (VAL-REMOVAL-005). Reliability fixtures
now require a PG-backed TaskStore. The engine-slow CI job and test-shards both
provision a PG service container. Tests skip locally when PG is not reachable.
The TCP probe is duplicated from packages/core/src/__test-utils__/pg-test-harness.ts
because that module is not exported from @fusion/core's public API.
*/
const PG_TEST_URL_BASE = process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";

function parseProbeTarget(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
    return { host, port: Number.isFinite(port) ? port : 5432 };
  } catch {
    return { host: "localhost", port: 5432 };
  }
}

function probeTcpReachable(host: string, port: number, timeoutMs = 1500): boolean {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  view[0] = 0; // 0 = pending, 1 = connected, 2 = failed

  let worker: Worker | null = null;
  try {
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const { Socket } = require("node:net");
      parentPort.on("message", (msg) => {
        const { host, port, timeoutMs, buf } = msg;
        const view = new Int32Array(buf);
        const socket = new Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => { view[0] = 1; Atomics.notify(view, 0); socket.destroy(); });
        const fail = () => { if (view[0] === 0) { view[0] = 2; Atomics.notify(view, 0); } socket.destroy(); };
        socket.once("error", fail);
        socket.once("timeout", fail);
        socket.connect(port, host);
      });
    `;
    worker = new Worker(workerCode, { eval: true });
    worker.postMessage({ host, port, timeoutMs, buf: shared });
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs + 500;
  while (view[0] === 0 && Date.now() < deadline) {
    Atomics.wait(view, 0, 0, 100);
  }

  void worker.terminate().catch(() => {});

  return view[0] === 1;
}

export const hasPg = process.env.FUSION_PG_TEST_SKIP !== "1" && (() => {
  if (!PG_TEST_URL_BASE) return false;
  const { host, port } = parseProbeTarget(PG_TEST_URL_BASE);
  return probeTcpReachable(host, port);
})();

function adminExecAsync(statement: string, timeoutMs = 15_000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const maintUrl = new URL(PG_TEST_URL_BASE);
  maintUrl.pathname = "/postgres";
  const child = exec(
    `psql "${maintUrl.toString()}" -v ON_ERROR_STOP=1 -f -`,
    { stdio: ["pipe", "pipe", "pipe"], env: process.env, timeout: timeoutMs },
    (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`adminExec psql failed: ${error.message}\nstderr: ${stderr}`));
        return;
      }
      resolve();
    },
  );
  if (child.stdin) {
    child.stdin.end(statement);
  }
  return promise;
}

let relDbCounter = 0;

async function createPgLayer(): Promise<{ layer: AsyncDataLayer; dbName: string }> {
  relDbCounter += 1;
  const dbName = `fusion_rel_${process.pid}_${relDbCounter}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await adminExecAsync(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist — safe to ignore
  }
  await adminExecAsync(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const backend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConn = await createConnectionSetFromUrl(backend, { poolMax: 1, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(schemaConn.migration);
  await schemaConn.close();
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 5, connectTimeoutSeconds: 5 });
  const layer = createAsyncDataLayer(connections);
  return { layer, dbName };
}

export type ReliabilityFixture = {
  rootDir: string;
  store: TaskStore;
  task: Task;
  settings: Settings;
  manager: SelfHealingManager;
  cleanup: () => Promise<void>;
  writeAndCommit: (file: string, content: string, message: string) => Promise<string>;
  createBranch: (branch: string) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  mergeTask: () => Promise<unknown>;
  selfHeal: {
    recoverAlreadyMergedReviewTasks: () => Promise<number>;
    recoverMisclassifiedFailures: () => Promise<number>;
    clearStaleBlockedBy: () => Promise<number>;
    autoReboundPausedScopeDecay: (opts?: { ignoreAgeGate?: boolean }) => Promise<number>;
    autoArchiveResolvedMetaTasks: () => Promise<number>;
    autoArchiveStalledMetaTasks: () => Promise<number>;
    runBoardStallAutoRecoverySweep: () => Promise<{ holders: string[]; recovered: number; unrecovered: boolean }>;
    reconcileDoneTaskIntegrity: () => Promise<number>;
  };
};

export async function makeReliabilityFixture(input: {
  taskId?: string;
  task?: Partial<Task>;
  settings?: Partial<Settings>;
} = {}): Promise<ReliabilityFixture> {
  const rootDir = await mkdtemp(join(reliabilityTestTempParent(), "fusion-reliability-"));
  const worktreeRoot = `${rootDir}-worktrees`;
  git(rootDir, "git init -b main");
  assertInitializedGitRepository(rootDir);
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  await writeFile(join(rootDir, "README.md"), "# fixture\n", "utf-8");
  git(rootDir, "git add README.md");
  git(rootDir, 'git commit -m "chore: init"');
  await mkdir(join(rootDir, ".fusion"), { recursive: true });

  const { layer, dbName } = await createPgLayer();
  const store = new TaskStore(rootDir, undefined, { asyncLayer: layer });
  await store.init();
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    mergeStrategy: "direct",
    autoMerge: true,
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    ...input.settings,
  } as Settings;
  await store.updateSettings(settings);

  const id = input.taskId ?? "FN-4361-T";
  const task = await store.createTask({
    id,
    title: id,
    description: "reliability fixture task",
    column: "in-review",
    branch: `fusion/${id.toLowerCase()}`,
    baseBranch: "main",
    prompt: `## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n`,
    steps: [],
    ...input.task,
  } as any);

  const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set() });

  return {
    rootDir,
    store,
    task,
    settings,
    manager,
    cleanup: async () => {
      manager.stop();
      await store.close();
      try { await layer.close(); } catch { /* best-effort */ }
      try { await adminExecAsync(`DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* best-effort */ }
      await rm(rootDir, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    },
    writeAndCommit: async (file, content, message) => {
      const absolute = join(rootDir, file);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, content, "utf-8");
      git(rootDir, `git add ${JSON.stringify(file)}`);
      git(rootDir, `git commit -m ${JSON.stringify(message)}`);
      return git(rootDir, "git rev-parse HEAD");
    },
    createBranch: async (branch) => {
      git(rootDir, `git checkout -b ${branch}`);
    },
    checkout: async (branch) => {
      git(rootDir, `git checkout ${branch}`);
    },
    mergeTask: async () => aiMergeTask(store, rootDir, task.id),
    selfHeal: {
      recoverAlreadyMergedReviewTasks: async () => manager.recoverAlreadyMergedReviewTasks(),
      recoverMisclassifiedFailures: async () => manager.recoverMisclassifiedFailures(),
      clearStaleBlockedBy: async () => manager.clearStaleBlockedBy(),
      autoReboundPausedScopeDecay: async (opts) => manager.autoReboundPausedScopeDecay(opts),
      autoArchiveResolvedMetaTasks: async () => manager.autoArchiveResolvedMetaTasks(),
      autoArchiveStalledMetaTasks: async () => manager.autoArchiveStalledMetaTasks(),
      runBoardStallAutoRecoverySweep: async () => manager.runBoardStallAutoRecoverySweep(),
      reconcileDoneTaskIntegrity: async () => manager.reconcileDoneTaskIntegrity(),
    },
  };
}
