/*
FNXC:TaskDetailPromptResilience 2026-07-10-15:00:
Symptom verification for the "task write API returns 500 for nearly everything" report:
GET/DELETE/PATCH/retry/reset/archive on a task all 500'd for every task (healthy ones
too) while the board list and create worked. Root cause: getTask — the shared load for
the entire per-task API — reads PROMPT.md directly and unguarded, so any read failure
(a root-owned PROMPT.md from a prior `sudo` run → EACCES, PROMPT.md being a directory →
EISDIR, etc.) threw and bricked every per-task operation, whereas the slim board list
never touches PROMPT.md.

Original symptom: getTask throws on an unreadable PROMPT.md, 500ing all per-task ops.
Exact reproduction: replace a task's PROMPT.md with a directory so readFile raises EISDIR.
Assertion it is gone: getTask resolves with the row (prompt degraded to ""), and a
representative mutation still succeeds — the per-task API is no longer bricked.
*/
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getTask PROMPT.md read resilience (task-write-API 500 regression)", () => {
  it("returns the task detail (and mutations still work) when PROMPT.md cannot be read", async () => {
    const { TaskStore } = await import("../store.js");

    const root = mkdtempSync(join(tmpdir(), "fn-task-detail-resilience-"));
    cleanupDirs.push(root);

    const store = new TaskStore(root);
    await store.init();
    try {
      const task = await store.createTask({ description: "task whose PROMPT.md becomes unreadable" });

      // Baseline: a healthy task detail loads and carries the prompt text.
      const baseline = await store.getTask(task.id);
      expect(baseline.id).toBe(task.id);
      expect(typeof baseline.prompt).toBe("string");

      // Make PROMPT.md unreadable deterministically: replace the file with a
      // directory so `readFile` raises EISDIR (mirrors the EACCES a root-owned
      // PROMPT.md produces, without depending on chmod/uid semantics).
      const promptPath = join(root, ".fusion", "tasks", task.id, "PROMPT.md");
      rmSync(promptPath, { force: true });
      mkdirSync(promptPath, { recursive: true });
      expect(existsSync(promptPath)).toBe(true);

      // The read path (GET /api/tasks/:id) must NOT throw — it degrades to an
      // empty prompt instead of 500ing.
      const detail = await store.getTask(task.id);
      expect(detail.id).toBe(task.id);
      expect(detail.prompt).toBe("");

      // The board read paths must survive too — listTasks/searchTasks slim-sync
      // steps from PROMPT.md for stepless tasks and would otherwise reject their
      // Promise.all and 500 the whole board/search on one unreadable file.
      const listed = await store.listTasks({ slim: true });
      expect(listed.some((t) => t.id === task.id)).toBe(true);
      const found = await store.searchTasks("unreadable", { slim: true });
      expect(Array.isArray(found)).toBe(true);

      // The mutation path must stay usable too. These store methods back the
      // reported failing endpoints and each independently touches PROMPT.md:
      //   PATCH   -> updateTask (title/description PROMPT.md heading sync)
      //   reset   -> moveTask reopen-to-todo (resetPromptCheckboxes) + updateStep
      //   archive -> archiveTask (readPromptForArchive)
      //   delete  -> deleteTask
      // A read failure in that PROMPT.md work must not brick the DB mutation.
      await expect(store.updateTask(task.id, { title: "renamed with broken PROMPT.md" })).resolves.toBeTruthy();
      const afterMutation = await store.getTask(task.id);
      expect(afterMutation.title).toBe("renamed with broken PROMPT.md");

      // Atomicity: an *explicit* prompt write that can't hit disk (PROMPT.md is a
      // directory → EISDIR) must reject AND leave the accompanying field change
      // uncommitted — no partial commit of the row with a stale prompt.
      await expect(
        store.updateTask(task.id, { prompt: "new spec body", title: "atomic-should-not-apply" }),
      ).rejects.toThrow();
      const afterFailedPromptWrite = await store.getTask(task.id);
      expect(afterFailedPromptWrite.title).toBe("renamed with broken PROMPT.md");

      // reset path: advance the task then reopen to todo, which triggers
      // resetPromptCheckboxes against the unreadable PROMPT.md. (New tasks start
      // in `triage`, so step through todo → in-progress → todo.)
      await expect(store.moveTask(task.id, "todo")).resolves.toBeTruthy();
      await expect(store.moveTask(task.id, "in-progress")).resolves.toBeTruthy();
      await expect(store.moveTask(task.id, "todo")).resolves.toBeTruthy();

      // Directly updating a step whose definition lives only in the unreadable
      // PROMPT.md genuinely cannot succeed, but the error must name the real
      // cause (PROMPT.md) rather than a misleading "task has 0 steps".
      await expect(store.updateStep(task.id, 0, "in-progress")).rejects.toThrow(/PROMPT\.md/);

      await expect(store.archiveTask(task.id)).resolves.toBeTruthy();
      const archived = await store.getTask(task.id);
      expect(archived.column).toBe("archived");

      await expect(store.deleteTask(task.id)).resolves.toBeTruthy();
    } finally {
      await store.close();
    }
  });
});
