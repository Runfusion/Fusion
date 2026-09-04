/*
FNXC:PromptReadBack 2026-09-04-05:12:
STAS-103 pins the prompt-return contract of updateTaskUnlockedImpl: an explicit prompt
update writes PROMPT.md to disk and must return a task whose prompt equals the persisted
content. The PG tasks row has no prompt column (rowToTask never hydrates it), so without
the assignment after a successful file write the returned prompt stays undefined and the
prompt-write tool's authoritative read-back check rejects every write. A failed PROMPT.md
write must not leave that assignment on the in-memory task or commit specPlanPrompt
evidence in the preceding row transaction.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";
import { updateTaskUnlockedImpl } from "../task-store/task-update.js";

const { persistPromptFile } = vi.hoisted(() => {
  const persistPromptFile = vi.fn();
  return { persistPromptFile };
});

vi.mock("../task-store/prompt-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-store/prompt-file.js")>();
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

const tempDirs: string[] = [];
afterEach(() => {
  persistPromptFile.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Same Proxy-fake-store pattern as task-update-awaiting-approval-reason.test.ts, except
// taskDir points at a fresh temp dir so PROMPT.md file I/O is real: unlisted store methods
// answer with async no-ops; only the return values the assertions depend on are stubbed.
function harness(task: Partial<Task>, options: { isWatching?: boolean } = {}) {
  const taskDir = mkdtempSync(join(tmpdir(), "stas-103-prompt-return-"));
  tempDirs.push(taskDir);
  const row = {
    id: "FN-1", column: "todo", dependencies: [], steps: [], log: [], status: null,
    title: "t", description: "d", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...task,
  } as unknown as Task;
  const taskCache = new Map<string, Task>();
  const store = {
    taskDir: () => taskDir,
    readTaskJson: async () => row,
    writeTaskJson: vi.fn(async () => undefined),
    atomicWriteTaskJson: vi.fn(async () => undefined),
    atomicWriteTaskJsonWithAudit: vi.fn(async () => undefined),
    syncAgentTaskLinkOnReassignment: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({})),
    assertNoDependencyCycle: vi.fn(async () => undefined),
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    getWorkflowDefinition: async () => undefined,
    emit: vi.fn(),
    isWatching: options.isWatching ?? false,
    taskCache,
  } as Record<string, unknown>;
  const proxied = new Proxy(store, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as unknown as TaskStore;
  return { store: proxied, row, taskDir, taskCache };
}

describe("updateTask returns the persisted prompt", () => {
  it("returns a task whose prompt equals the content it wrote to PROMPT.md", async () => {
    // Pre-fix this failed: the row has no prompt column, so the returned prompt was undefined.
    const { store, taskDir } = harness({});
    const content = prompt("STAS-103 core contract");

    const updated = await updateTaskUnlockedImpl(store, "FN-1", { prompt: content } as never);

    expect(updated.prompt).toBe(content);
    const onDisk = await readFile(join(taskDir, "PROMPT.md"));
    expect(onDisk.equals(Buffer.from(content))).toBe(true);
  });

  it("returns an empty-string prompt and writes an empty PROMPT.md", async () => {
    const { store, taskDir } = harness({});

    const updated = await updateTaskUnlockedImpl(store, "FN-1", { prompt: "" } as never);

    expect(updated.prompt).toBe("");
    const bytes = await readFile(join(taskDir, "PROMPT.md"));
    expect(bytes.length).toBe(0);
  });

  it("leaves prompt undefined on a non-prompt update when the row has no prompt", async () => {
    const { store } = harness({});

    const updated = await updateTaskUnlockedImpl(store, "FN-1", { title: "renamed" } as never);

    expect(updated.title).toBe("renamed");
    expect(updated.prompt).toBeUndefined();
  });

  it("leaves a stored prompt untouched on a title-only update", async () => {
    const { store, taskDir } = harness({ prompt: prompt("original spec") });
    writeFileSync(join(taskDir, "PROMPT.md"), prompt("original spec"));

    const updated = await updateTaskUnlockedImpl(store, "FN-1", { title: "renamed" } as never);

    expect(updated.prompt).toBe(prompt("original spec"));
  });

  it("carries the persisted prompt into the watcher task cache copy", async () => {
    const { store, taskCache } = harness({}, { isWatching: true });
    const content = prompt("cache contract");

    await updateTaskUnlockedImpl(store, "FN-1", { prompt: content } as never);

    expect(taskCache.get("FN-1")?.prompt).toBe(content);
  });

  it("overwrites an existing PROMPT.md and returns the new content", async () => {
    const { store, taskDir } = harness({});
    writeFileSync(join(taskDir, "PROMPT.md"), prompt("previous spec"));
    const next = prompt("rewritten spec");

    const updated = await updateTaskUnlockedImpl(store, "FN-1", { prompt: next } as never);

    expect(updated.prompt).toBe(next);
    expect(await readFile(join(taskDir, "PROMPT.md"), "utf-8")).toBe(next);
  });

  it("does not expose an unwritten prompt when PROMPT.md persistence fails", async () => {
    /*
    FNXC:PromptReadBack 2026-09-04-05:12:
    If writePromptFileAtomic throws after the task-row commit, in-memory metadata and
    the watcher cache must still omit the requested revision so fallback hydration cannot
    surface a prompt the authoritative file never persisted. The row transaction must also
    omit specPlanPrompt so current-plan evidence cannot commit the unwritten revision.
    */
    const { store, row, taskDir, taskCache } = harness({}, { isWatching: true });
    const content = prompt("must not leak");
    persistPromptFile.mockRejectedValueOnce(
      new Error("EIO: simulated PROMPT.md write failure"),
    );

    await expect(
      updateTaskUnlockedImpl(store, "FN-1", { prompt: content } as never),
    ).rejects.toThrow(/EIO: simulated PROMPT.md write failure/);

    expect(row.prompt).toBeUndefined();
    expect(taskCache.get("FN-1")).toBeUndefined();
    expect(existsSync(join(taskDir, "PROMPT.md"))).toBe(false);
    const auditCalls = vi.mocked(store.atomicWriteTaskJsonWithAudit).mock.calls;
    expect(auditCalls.length).toBeGreaterThan(0);
    expect(auditCalls.every((call) => call[4] === undefined)).toBe(true);
  });
});
