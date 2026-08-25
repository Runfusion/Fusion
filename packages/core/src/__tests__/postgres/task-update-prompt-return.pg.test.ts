/*
FNXC:PromptReadBack 2026-08-22-16:15:
STAS-103 pins the prompt-return contract through the real PostgreSQL backend-mode store:
rowToTask never hydrates a prompt column (there is none), so the updateTask return, the
getTask detail read (file-based enrichment), and the on-disk PROMPT.md bytes must all
reflect the exact content that was written.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { type TaskStore } from "../../store.js";

const prompt = (body: string) =>
  `# Task\n\n## Mission\n\n${body}\n\n## File Scope\n\n- packages/core/src/store.ts\n\n## Steps\n\n1. Verify prompt return\n\n## Completion Criteria\n\n- [ ] updateTask returns the prompt\n\n## Do NOT\n\n- Drop the prompt\n\n## Dependencies\n\n- None\n`;

pgDescribe("updateTask prompt return (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_update_prompt_return" });
  let store: TaskStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); store = h.store(); });
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
});
