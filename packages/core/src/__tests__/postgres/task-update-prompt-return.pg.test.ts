/*
FNXC:PromptReadBack 2026-09-04-05:12:
STAS-103 pins the prompt-return contract through the real PostgreSQL backend-mode store:
rowToTask never hydrates a prompt column (there is none), so the updateTask return, the
getTask detail read (file-based enrichment), and the on-disk PROMPT.md bytes must all
reflect the exact content that was written. Current-plan evidence must not commit a
revision whose PROMPT.md write later failed.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { type TaskStore } from "../../store.js";

const { persistPromptFile } = vi.hoisted(() => {
  const persistPromptFile = vi.fn();
  return { persistPromptFile };
});

vi.mock("../../task-store/prompt-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../task-store/prompt-file.js")>();
  persistPromptFile.mockImplementation((promptPath: string, content: string) =>
    actual.writePromptFileAtomic(promptPath, content),
  );
  return {
    ...actual,
    writePromptFileAtomic: persistPromptFile,
  };
});

const prompt = (body: string) =>
  `# Task\n\n## Mission\n\n${body}\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Verify prompt return\n\n## Completion Criteria\n\n- [ ] updateTask returns the prompt\n\n## Do NOT\n\n- Drop the prompt\n\n## Dependencies\n\n- None\n`;

pgDescribe("updateTask prompt return (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_update_prompt_return" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { persistPromptFile.mockClear(); await h.beforeEach(); store = h.store(); });
  afterEach(h.afterEach);

  it.sequential("returns the persisted prompt and the detail read exposes the same prompt", async () => {
    const task = await store.createTask({ description: "prompt return contract" });
    const content = prompt("pg contract body");

    const updated = await store.updateTask(task.id, { prompt: content });

    expect(updated).toBeDefined();
    expect(updated?.prompt).toBe(content);
    expect((await store.getTask(task.id)).prompt).toBe(content);
  });

  it.sequential("writes the exact requested bytes to PROMPT.md in the store task dir", async () => {
    const task = await store.createTask({ description: "prompt disk bytes" });
    const content = prompt("pg disk bytes body");

    await store.updateTask(task.id, { prompt: content });

    const bytes = await readFile(join(store.taskDir(task.id), "PROMPT.md"));
    expect(bytes.equals(Buffer.from(content))).toBe(true);
  });

  it.sequential("a second rewrite returns the new content and the disk matches it", async () => {
    const task = await store.createTask({ description: "prompt rewrite" });
    const second = prompt("second revision");

    await store.updateTask(task.id, { prompt: prompt("first revision") });
    const updated = await store.updateTask(task.id, { prompt: second });

    expect(updated?.prompt).toBe(second);
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(second);
  });

  it.sequential("does not commit current-plan evidence when PROMPT.md persistence fails", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-05:12:
    The PG row transaction used to append specPlanPrompt as current-plan evidence before
    writePromptFileAtomic. If that file write failed, spec-lock and drift reconciliation
    could observe an unwritten revision. After a durable first prompt, a failed rewrite
    must leave evidence and on-disk PROMPT.md on the first revision.
    */
    const task = await store.createTask({ description: "prompt evidence isolation" });
    const first = prompt("first revision that is on disk");
    const leaked = prompt("must not leak into plan evidence");

    await store.updateTask(task.id, { prompt: first });
    const before = await store.getLatestCurrentPlanEvidence(task.id);
    expect(before).toBeDefined();
    expect(before?.plan.sections.mission.canonical).toContain("first revision that is on disk");

    persistPromptFile.mockRejectedValueOnce(
      new Error("EIO: simulated PROMPT.md write failure"),
    );

    await expect(store.updateTask(task.id, { prompt: leaked })).rejects.toThrow(
      /EIO: simulated PROMPT.md write failure/,
    );

    const after = await store.getLatestCurrentPlanEvidence(task.id);
    expect(after?.sourceHash).toBe(before?.sourceHash);
    expect(after?.plan).toEqual(before?.plan);
    expect(JSON.stringify(after)).not.toContain("must not leak into plan evidence");
    expect(await readFile(join(store.taskDir(task.id), "PROMPT.md"), "utf8")).toBe(first);
  });
});
