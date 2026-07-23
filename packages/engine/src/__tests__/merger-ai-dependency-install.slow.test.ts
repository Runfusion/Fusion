import { describe, it, expect, vi, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { runAiMerge } from "../merge/merger-ai.js";
import { computeLockfileHash, INSTALL_MARKER_RELPATH } from "../merge/merge-dependency-sync.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
afterAll(() => {
  for (const d of tracked) {
    try { rmSync(d, RM); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

function initRepoWithBranch(): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-deps-test-"));
  tracked.add(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, "checkout -q -b fusion/fn-1");
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");
  git(dir, "checkout -q main");
  return { dir };
}

function makeStore(settingsOverrides: Record<string, unknown> = {}) {
  const task: any = {
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
  };
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 }, ...settingsOverrides })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
  };
  return store;
}

function realMergeAgent(branch = "fusion/fn-1") {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

function nodeAppendCwdCommand(): string {
  return `node -e "require('fs').appendFileSync(process.env.FN_INSTALL_LOG, process.cwd() + '\\n')"`;
}

function makeInstallLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-install-log-"));
  tracked.add(dir);
  return join(dir, "install.log");
}

function readInstallLog(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
}

function installFakePackageManagerBins(_dir: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "fusion-ai-fake-bin-"));
  tracked.add(binDir);
  mkdirSync(binDir, { recursive: true });
  for (const bin of ["pnpm", "npm", "yarn", "bun"]) {
    const script = join(binDir, bin);
    writeFileSync(script, `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(process.env.FN_INSTALL_LOG, JSON.stringify({ bin: ${JSON.stringify(bin)}, args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nprocess.exit(Number(process.env.FN_INSTALL_EXIT || 0));\n`);
    chmodSync(script, 0o755);
  }
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  return previousPath;
}

function commitWarmInstallMarker(dir: string): void {
  const hash = computeLockfileHash(dir);
  if (!hash) throw new Error("expected lockfile hash");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, INSTALL_MARKER_RELPATH), hash);
  execSync(`git add -f ${INSTALL_MARKER_RELPATH}`, { cwd: dir, stdio: "pipe" });
  git(dir, "commit -q -m 'record install marker'");
}

describe("runAiMerge dependency install", () => {
  it("runs configured worktreeInitCommand in the AI-merge clean room before merge agents", async () => {
    const { dir } = initRepoWithBranch();
    const installLog = makeInstallLog();
    const store = makeStore({ worktreeInitCommand: nodeAppendCwdCommand() });
    const mergeAgent = realMergeAgent();

    process.env.FN_INSTALL_LOG = installLog;
    try {
      await runAiMerge(store, dir, "FN-1", { manual: true }, {
        mergeAgent,
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });
    } finally {
      delete process.env.FN_INSTALL_LOG;
    }

    const installCwds = readInstallLog(installLog);
    expect(installCwds).toHaveLength(1);
    expect(installCwds[0]).toMatch(/fusion-ai-merge-fn-1-/);
    expect(mergeAgent).toHaveBeenCalledTimes(1);
    const timingLogOrder = store.appendAgentLog.mock.invocationCallOrder.find((_: number, index: number) =>
      String(store.appendAgentLog.mock.calls[index]?.[1]).includes("[timing] AI merge dependency sync completed"),
    );
    expect(timingLogOrder).toBeLessThan(mergeAgent.mock.invocationCallOrder[0]);
  });

  it("infers lockfile install commands in the AI-merge clean room", async () => {
    for (const testCase of [
      { lockfile: "pnpm-lock.yaml", expectedBin: "pnpm", expectedArgs: ["install", "--frozen-lockfile"] },
      { lockfile: "package-lock.json", expectedBin: "npm", expectedArgs: ["install"] },
    ]) {
      const { dir } = initRepoWithBranch();
      writeFileSync(join(dir, testCase.lockfile), "lock\n");
      git(dir, `add ${testCase.lockfile}`);
      git(dir, `commit -q -m 'add ${testCase.lockfile}'`);
      const installLog = makeInstallLog();
      const previousPath = installFakePackageManagerBins(dir);
      process.env.FN_INSTALL_LOG = installLog;
      try {
        await runAiMerge(makeStore(), dir, "FN-1", { manual: true }, {
          mergeAgent: realMergeAgent(),
          reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
        });
      } finally {
        process.env.PATH = previousPath;
        delete process.env.FN_INSTALL_LOG;
      }

      const [entry] = readInstallLog(installLog).map((line) => JSON.parse(line));
      expect(entry).toEqual(expect.objectContaining({ bin: testCase.expectedBin, args: testCase.expectedArgs }));
      expect(entry.cwd).toMatch(/fusion-ai-merge-fn-1-/);
    }
  });

  it("proceeds without install when no configured command or known lockfile exists", async () => {
    const { dir } = initRepoWithBranch();
    const store = makeStore();
    const mergeAgent = realMergeAgent();

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent,
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(mergeAgent).toHaveBeenCalledTimes(1);
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-1",
      expect.stringContaining("(no command)"),
      "text",
      undefined,
      "merger",
    );
  });

  it("skips inferred installs on a matching marker but never skips configured init commands", async () => {
    const { dir } = initRepoWithBranch();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
    git(dir, "add pnpm-lock.yaml");
    git(dir, "commit -q -m 'add pnpm lock'");
    commitWarmInstallMarker(dir);
    const installLog = makeInstallLog();
    const previousPath = installFakePackageManagerBins(dir);
    process.env.FN_INSTALL_LOG = installLog;
    try {
      await runAiMerge(makeStore(), dir, "FN-1", { manual: true }, {
        mergeAgent: realMergeAgent(),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });
    } finally {
      process.env.PATH = previousPath;
      delete process.env.FN_INSTALL_LOG;
    }
    expect(readInstallLog(installLog)).toHaveLength(0);

    const { dir: configuredDir } = initRepoWithBranch();
    writeFileSync(join(configuredDir, "pnpm-lock.yaml"), "lock\n");
    git(configuredDir, "add pnpm-lock.yaml");
    git(configuredDir, "commit -q -m 'add pnpm lock'");
    commitWarmInstallMarker(configuredDir);
    const configuredLog = makeInstallLog();
    process.env.FN_INSTALL_LOG = configuredLog;
    try {
      await runAiMerge(makeStore({ worktreeInitCommand: nodeAppendCwdCommand() }), configuredDir, "FN-1", { manual: true }, {
        mergeAgent: realMergeAgent(),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });
    } finally {
      delete process.env.FN_INSTALL_LOG;
    }
    expect(readInstallLog(configuredLog)).toHaveLength(1);
  });

  it("hard-fails configured install failures and propagates aborts", async () => {
    const { dir } = initRepoWithBranch();
    const mergeAgent = realMergeAgent();

    await expect(runAiMerge(makeStore({ worktreeInitCommand: `node -e "process.stderr.write('install failed'); process.exit(7)"` }), dir, "FN-1", { manual: true }, {
      mergeAgent,
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toThrow(/Dependency sync failed.*install failed/);
    expect(mergeAgent).not.toHaveBeenCalled();

    const { dir: abortDir } = initRepoWithBranch();
    const controller = new AbortController();
    const abortStore = makeStore({ worktreeInitCommand: `node -e "process.exit(0)"` });
    abortStore.appendAgentLog.mockImplementation(async (_id: string, message: string) => {
      if (String(message).includes("Syncing dependencies")) controller.abort();
    });
    /*
    FNXC:AIMerge 2026-06-25-04:07:
    Merge-layer aborts must surface as the canonical MergeAbortedError consumed by project-engine.ts abort detection; landOneRepo intentionally re-normalizes dependency-sync inner AbortError via throwIfAborted.
    */
    await expect(runAiMerge(abortStore, abortDir, "FN-1", { manual: true, signal: controller.signal }, {
      mergeAgent: realMergeAgent(),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toMatchObject({ name: "MergeAbortedError" });
  });

  it("runs dependency install again after a concurrent integration advance rebuild", async () => {
    const { dir } = initRepoWithBranch();
    const installLog = makeInstallLog();
    let attempts = 0;
    const mergeAgent = vi.fn(async (cwd: string) => {
      await realMergeAgent()(cwd);
      attempts++;
      if (attempts === 1) {
        writeFileSync(join(dir, "race.txt"), "race\n");
        git(dir, "add race.txt");
        git(dir, "commit -q -m 'main advanced concurrently'");
      }
    });

    process.env.FN_INSTALL_LOG = installLog;
    try {
      await runAiMerge(makeStore({ worktreeInitCommand: nodeAppendCwdCommand() }), dir, "FN-1", { manual: true }, {
        mergeAgent,
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });
    } finally {
      delete process.env.FN_INSTALL_LOG;
    }

    expect(mergeAgent).toHaveBeenCalledTimes(2);
    expect(readInstallLog(installLog)).toHaveLength(2);
  });
});
