import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAN_DOCUMENT_KEY,
  mirrorPlanToProjectDb,
  persistPlanArtifact,
  reconcileWorktreePlanArtifact,
  relativePromptPath,
} from "../plan-artifact-writeback.js";

/*
FNXC:PlanArtifactPersistence 2026-07-26-03:55:
Invariant under test (not just the reported repro): a plan written anywhere a planning session can write it
ends up (a) in the MAIN project `.fusion/` folder and (b) in the project database. Surfaces covered here:
worktree-stranded write, root write, empty/absent worktree file, identical content, and persistence failure.
*/

const TASK_ID = "FN-9001";
const REAL_SPEC = "# Task: FN-9001 - Real spec\n\n## Mission\n\nDo the thing.\n";

interface FakeStore {
  updateTask: ReturnType<typeof vi.fn>;
  upsertTaskDocument: ReturnType<typeof vi.fn>;
  getTaskDocument: ReturnType<typeof vi.fn>;
  documents: Map<string, string>;
}

function createFakeStore(rootDir: string): FakeStore {
  const documents = new Map<string, string>();
  return {
    documents,
    // Mirrors the real `updateTask({ prompt })` contract: the project-root PROMPT.md is the artifact it writes.
    updateTask: vi.fn(async (id: string, updates: { prompt?: string }) => {
      if (updates.prompt !== undefined) {
        const dir = join(rootDir, ".fusion", "tasks", id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }
    }),
    upsertTaskDocument: vi.fn(async (id: string, input: { key: string; content: string }) => {
      documents.set(`${id}:${input.key}`, input.content);
      return { key: input.key, content: input.content };
    }),
    getTaskDocument: vi.fn(async (id: string, key: string) => {
      const content = documents.get(`${id}:${key}`);
      return content === undefined ? null : { key, content };
    }),
  };
}

async function writeSpec(baseDir: string, taskId: string, content: string): Promise<void> {
  const path = join(baseDir, relativePromptPath(taskId));
  await mkdir(join(baseDir, ".fusion", "tasks", taskId), { recursive: true });
  await writeFile(path, content);
}

describe("plan artifact write-back", () => {
  let rootDir: string;
  let worktreeDir: string;
  let store: FakeStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-plan-root-"));
    worktreeDir = await mkdtemp(join(tmpdir(), "fusion-plan-worktree-"));
    store = createFakeStore(rootDir);
  });

  it("copies a worktree-stranded plan back into the main project .fusion folder", async () => {
    await writeSpec(worktreeDir, TASK_ID, REAL_SPEC);

    const result = await reconcileWorktreePlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
    });

    expect(result.outcome).toBe("recovered");
    expect(result.content).toBe(REAL_SPEC);
    // Persisted through the single validated path, not a raw copy.
    expect(store.updateTask).toHaveBeenCalledWith(TASK_ID, { prompt: REAL_SPEC });
    await expect(readFile(join(rootDir, relativePromptPath(TASK_ID)), "utf-8")).resolves.toBe(REAL_SPEC);
  });

  it("stores the plan in the project database as the plan task document", async () => {
    await writeSpec(worktreeDir, TASK_ID, REAL_SPEC);

    const result = await persistPlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
      author: "triage",
    });

    expect(result.outcome).toBe("recovered");
    expect(result.mirrored).toBe(true);
    expect(store.documents.get(`${TASK_ID}:${PLAN_DOCUMENT_KEY}`)).toBe(REAL_SPEC);
  });

  it("mirrors a root-written plan into the database even when planning never used a worktree", async () => {
    await writeSpec(rootDir, TASK_ID, REAL_SPEC);

    const result = await persistPlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: rootDir,
    });

    expect(result.outcome).toBe("not-worktree");
    expect(result.mirrored).toBe(true);
    expect(store.documents.get(`${TASK_ID}:${PLAN_DOCUMENT_KEY}`)).toBe(REAL_SPEC);
    // Nothing to copy back — the root copy is already authoritative.
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("never overwrites an authoritative root plan with an empty worktree file", async () => {
    await writeSpec(rootDir, TASK_ID, REAL_SPEC);
    await writeSpec(worktreeDir, TASK_ID, "   \n");

    const result = await reconcileWorktreePlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
    });

    expect(result.outcome).toBe("worktree-artifact-empty");
    expect(store.updateTask).not.toHaveBeenCalled();
    await expect(readFile(join(rootDir, relativePromptPath(TASK_ID)), "utf-8")).resolves.toBe(REAL_SPEC);
  });

  it("is a no-op when the planner used the durable writer and left nothing in the worktree", async () => {
    await writeSpec(rootDir, TASK_ID, REAL_SPEC);

    const result = await reconcileWorktreePlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
    });

    expect(result.outcome).toBe("no-worktree-artifact");
    expect(result.content).toBe(REAL_SPEC);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("does not rewrite when the worktree copy already matches the root copy", async () => {
    await writeSpec(rootDir, TASK_ID, REAL_SPEC);
    await writeSpec(worktreeDir, TASK_ID, REAL_SPEC);

    const result = await reconcileWorktreePlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
    });

    expect(result.outcome).toBe("already-authoritative");
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("leaves the root copy untouched and stays non-fatal when persistence fails", async () => {
    await writeSpec(rootDir, TASK_ID, REAL_SPEC);
    await writeSpec(worktreeDir, TASK_ID, "# Task: FN-9001 - Rewritten\n");
    store.updateTask.mockRejectedValueOnce(new Error("invalid file scope"));
    const warn = vi.fn();

    const result = await reconcileWorktreePlanArtifact({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store: store as any,
      taskId: TASK_ID,
      rootDir,
      planningCwd: worktreeDir,
      logger: { warn },
    });

    expect(result.outcome).toBe("recovery-failed");
    expect(warn).toHaveBeenCalled();
    await expect(readFile(join(rootDir, relativePromptPath(TASK_ID)), "utf-8")).resolves.toBe(REAL_SPEC);
  });

  it("skips redundant document revisions when the mirrored plan is unchanged", async () => {
    await expect(mirrorPlanToProjectDb(store as never, TASK_ID, REAL_SPEC)).resolves.toBe(true);
    await expect(mirrorPlanToProjectDb(store as never, TASK_ID, REAL_SPEC)).resolves.toBe(false);
    expect(store.upsertTaskDocument).toHaveBeenCalledTimes(1);
  });

  it("never mirrors empty plan content", async () => {
    await expect(mirrorPlanToProjectDb(store as never, TASK_ID, "  \n ")).resolves.toBe(false);
    expect(store.upsertTaskDocument).not.toHaveBeenCalled();
  });

  it("stays non-fatal when the database mirror fails", async () => {
    store.upsertTaskDocument.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.fn();
    await expect(mirrorPlanToProjectDb(store as never, TASK_ID, REAL_SPEC, { logger: { warn } })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
