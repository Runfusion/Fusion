import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { DEFAULT_SETTINGS, TaskStore, type Settings, type Task } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";

export const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;

export function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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
    reconcileDoneTaskIntegrity: () => Promise<number>;
  };
};

export async function makeReliabilityFixture(input: {
  taskId?: string;
  task?: Partial<Task>;
  settings?: Partial<Settings>;
} = {}): Promise<ReliabilityFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-reliability-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  await writeFile(join(rootDir, "README.md"), "# fixture\n", "utf-8");
  git(rootDir, "git add README.md");
  git(rootDir, 'git commit -m "chore: init"');
  await mkdir(join(rootDir, ".fusion"), { recursive: true });

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
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
      store.close();
      await rm(rootDir, { recursive: true, force: true });
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
      reconcileDoneTaskIntegrity: async () => manager.reconcileDoneTaskIntegrity(),
    },
  };
}
