import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";

import { appendFile, readFile, writeFile, mkdir, rm, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as projectMemory from "../project-memory.js";
import { AgentStore } from "../agent-store.js";
import { CentralDatabase } from "../central-db.js";
import { InvalidFileScopeError, isValidFileScopeEntry, parseStepHeadings, TaskStore, TaskHasDependentsError } from "../store.js";
import { buildResearchDocumentKey, type Task } from "../types.js";
import { createSharedTaskStoreTestHarness, makeTmpDir } from "./store-test-helpers.js";

describe("TaskStore", () => {
  const harness = createSharedTaskStoreTestHarness();

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    rootDir = harness.rootDir();
    globalDir = harness.globalDir();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  const createTestTask = () => harness.createTestTask();
  const createTaskWithSteps = () => harness.createTaskWithSteps();
  const deleteTaskDir = (taskId: string) => harness.deleteTaskDir(taskId);
  const createSourceIssueFixture = () => harness.createSourceIssueFixture();
  const insertLogEntryWithTimestamp = (...args: any[]) => (harness as any).insertLogEntryWithTimestamp(...args);

  describe("parseStepsFromPrompt", () => {
    it("returns empty array when task directory is missing", async () => {
      const task = await createTaskWithSteps();
      await deleteTaskDir(task.id);

      const steps = await store.parseStepsFromPrompt(task.id);
      expect(steps).toEqual([]);
    });

    it("parses depends annotations from PROMPT.md (1-indexed → 0-indexed)", async () => {
      const task = await store.createTask({ description: "Task with depends" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task

## Steps

### Step 1: First

### Step 2 (depends: 1): Second

### Step 3 (depends: 1,2): Third
`,
      );
      const steps = await store.parseStepsFromPrompt(task.id);
      expect(steps).toEqual([
        { name: "First", status: "pending" },
        { name: "Second", status: "pending", dependsOn: [0] },
        { name: "Third", status: "pending", dependsOn: [0, 1] },
      ]);
    });
  });

  describe("parseStepHeadings (step-inversion U1)", () => {
    it("parses unannotated headings byte-identically to the legacy regex", () => {
      const content = `## Steps

### Step 0: Preflight

- [ ] x

### Step 1: Implementation

### Step 2: Testing
`;
      // The legacy behavior: name = text after the first colon, trimmed; no dependsOn.
      expect(parseStepHeadings(content)).toEqual([
        { name: "Preflight", status: "pending" },
        { name: "Implementation", status: "pending" },
        { name: "Testing", status: "pending" },
      ]);
    });

    it("matches the legacy regex output exactly for varied unannotated headings", () => {
      const content = [
        "### Step 0: A",
        "### Step 12: Multi word title",
        "### Step 3 — dash but no annotation: Real Name",
        "### Step 4: trailing spaces here   ",
        "### Step 5 no colon at all",
        "not a step heading: ignored",
      ].join("\n");
      // Reference: the original regex.
      const legacy: { name: string; status: "pending" }[] = [];
      const re = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        legacy.push({ name: m[1].trim(), status: "pending" });
      }
      expect(parseStepHeadings(content)).toEqual(legacy);
    });

    it("parses (depends: 1,2) into 0-indexed dependsOn", () => {
      expect(parseStepHeadings("### Step 3 (depends: 1,2): Title")).toEqual([
        { name: "Title", status: "pending", dependsOn: [0, 1] },
      ]);
    });

    it("dedupes and sorts depends values", () => {
      expect(parseStepHeadings("### Step 5 (depends: 3,1,3,2): T")).toEqual([
        { name: "T", status: "pending", dependsOn: [0, 1, 2] },
      ]);
    });

    it("empty depends list yields no dependsOn", () => {
      expect(parseStepHeadings("### Step 2 (depends: ): T")).toEqual([
        { name: "T", status: "pending" },
      ]);
    });

    it("falls back deterministically on a malformed depends annotation (name after colon following the paren)", () => {
      // 'bad' is not a positive integer → fallback: name starts after the colon
      // following the closing paren.
      expect(parseStepHeadings("### Step 1 (depends: bad): Real Title")).toEqual([
        { name: "Real Title", status: "pending" },
      ]);
    });

    it("falls back deterministically when the annotation has no closing paren", () => {
      // No closing paren → name starts after the FIRST colon (inside `depends:`),
      // per the documented deterministic fallback.
      expect(parseStepHeadings("### Step 1 (depends: 1,2 oops: Title")).toEqual([
        { name: "1,2 oops: Title", status: "pending" },
      ]);
    });
  });


  describe("parseDependenciesFromPrompt", () => {
    it("returns single dependency from PROMPT.md", async () => {
      const task = await store.createTask({ description: "Task with dep" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with dep

## Dependencies

- **Task:** FN-001 (must be complete first)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["FN-001"]);
    });

    it("returns multiple dependencies in order", async () => {
      const task = await store.createTask({ description: "Task with deps" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Task with deps

## Dependencies

- **Task:** FN-010 (first dep)
- **Task:** FN-020 (second dep)
- **Task:** PROJ-003 (third dep)

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual(["FN-010", "FN-020", "PROJ-003"]);
    });

    it("returns empty array when dependencies section says None", async () => {
      const task = await store.createTask({ description: "No deps" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No deps

## Dependencies

- **None**

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when no Dependencies section exists", async () => {
      const task = await store.createTask({ description: "No section" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No section

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when task has no PROMPT.md file", async () => {
      const task = await store.createTask({ description: "No prompt" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      // Delete the PROMPT.md that createTask generates
      await unlink(join(dir, "PROMPT.md"));

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });

    it("returns empty array when task directory is missing", async () => {
      const task = await store.createTask({ description: "No directory" });
      await deleteTaskDir(task.id);

      const deps = await store.parseDependenciesFromPrompt(task.id);
      expect(deps).toEqual([]);
    });
  });


  describe("isValidFileScopeEntry", () => {
    it.each([
      "packages/core/src/store.ts",
      "packages/engine/src/**/*.ts",
      "packages/core/*",
      "app/*.tsx",
      "Makefile",
      "Dockerfile",
      "AGENTS.md",
      ".changeset/foo-bar.md",
      "vendor/some-pkg/LICENSE",
    ])("accepts %s", (entry) => {
      expect(isValidFileScopeEntry(entry)).toBe(true);
    });

    it.each([
      "fusion/fn-4280",
      "origin/fusion/fn-4280",
      "refs/heads/main",
      "HEAD",
      "main",
      "fusion",
      "https://example.com/a.ts",
      "git@github.com:owner/repo.git",
      "deadbeefcafe1234",
      "../escape/path.ts",
      "/absolute/path.ts",
      "",
      "   ",
    ])("rejects %s", (entry) => {
      expect(isValidFileScopeEntry(entry)).toBe(false);
    });
  });

  describe("parseFileScopeFromPrompt", () => {
    it("returns paths when File Scope is followed by another heading", async () => {
      const task = await store.createTask({ description: "Mid-file scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Mid-file scope

## File Scope

- \`packages/core/src/store.ts\`
- \`packages/core/src/store.test.ts\`

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/src/store.ts",
        "packages/core/src/store.test.ts",
      ]);
    });

    it("returns all paths when File Scope is the last section", async () => {
      const task = await store.createTask({
        description: "End-of-file scope",
      });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: End-of-file scope

## Steps

### Step 0: Preflight
- [ ] Check things

## File Scope

- \`packages/core/src/store.ts\`
- \`packages/core/src/store.test.ts\`
- \`packages/core/src/utils.ts\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/src/store.ts",
        "packages/core/src/store.test.ts",
        "packages/core/src/utils.ts",
      ]);
    });

    it("returns empty array when no File Scope section exists", async () => {
      const task = await store.createTask({ description: "No scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: No scope

## Steps

### Step 0: Preflight
- [ ] Check things
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("returns empty array when PROMPT.md does not exist", async () => {
      const task = await store.createTask({ description: "No prompt" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await unlink(join(dir, "PROMPT.md"));

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("returns empty array when task directory is missing", async () => {
      const task = await store.createTask({ description: "No prompt directory" });
      await deleteTaskDir(task.id);

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([]);
    });

    it("handles glob patterns in backtick-quoted paths", async () => {
      const task = await store.createTask({ description: "Glob scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Glob scope

## File Scope

- \`packages/core/*\`
- \`packages/cli/src/commands/dashboard.ts\`
- \`packages/engine/src/**/*.ts\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/*",
        "packages/cli/src/commands/dashboard.ts",
        "packages/engine/src/**/*.ts",
      ]);
    });

    it("drops invalid entries from mixed file scope declarations", async () => {
      const task = await store.createTask({ description: "Mixed file scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Mixed file scope

## File Scope

- \`packages/dashboard/app/components/TaskDetailModal.tsx\`
- \`fusion/fn-4280\`
- \`origin/fusion/fn-4280\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual(["packages/dashboard/app/components/TaskDetailModal.tsx"]);
    });

    it("deduplicates effective write scope while preserving broad mixed-case source globs", async () => {
      const task = await store.createTask({ description: "Duplicate effective scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Duplicate effective scope

## File Scope

- \`packages/core/**\`
- \`packages/core/**\`
- \`Packages/MobileApp/**\`
- \`Tests/AtlasNotesMobileUITests/**\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/**",
        "Packages/MobileApp/**",
        "Tests/AtlasNotesMobileUITests/**",
      ]);
    });

    it("excludes poisoned FN-779/FN-756 context-only paths from effective write scope", async () => {
      const task = await store.createTask({ description: "Poisoned Fusion prompt" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Poisoned Fusion prompt

## File Scope

Expected touched paths in \`/Users/plarson/src/Fusion-local-runtime\`:

- \`packages/core/src/store.ts\`
- \`packages/engine/src/scheduler.ts\`
- \`packages/dashboard/**\`
- \`packages/cli/**\`
- \`packages/core/src/__tests__/store-parsing.test.ts\`

Forbidden paths / non-goals:

- Do not edit Atlas Notes Swift/mobile files: \`project.yml\`, \`AtlasNotes.xcodeproj/**\`, \`Tests/AtlasNotesMobileUITests/**\`, \`Packages/MobileApp/**\`, \`Sources/**\`.
- Do not hand-edit \`.fusion/fusion.db\` or \`.fusion/tasks/*/task.json\`.
- Generated locks such as \`Packages/*/Package.resolved\` are evidence only.
- \`.changeset/*.md\` is required only if published behavior changes.
- Operator routes/actions: \`/tasks/:id\`, \`fn_task_update\`, \`review\`, \`merge\`, \`retry\`, \`archive\`.
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "packages/core/src/store.ts",
        "packages/engine/src/scheduler.ts",
        "packages/dashboard/**",
        "packages/cli/**",
        "packages/core/src/__tests__/store-parsing.test.ts",
      ]);
    });

    it("keeps true Atlas mobile hot-file family writes when declared as implementation scope", async () => {
      const task = await store.createTask({ description: "Atlas mobile scope" });
      const dir = join(rootDir, ".fusion", "tasks", task.id);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${task.id}: Atlas mobile scope

## File Scope

Expected touched paths:

- \`project.yml\`
- \`AtlasNotes.xcodeproj/**\`
- \`Tests/AtlasNotesMobileUITests/**\`
- \`Packages/MobileApp/**\`
- \`Sources/AtlasNotesMobileApp/**\`
`,
      );

      const paths = await store.parseFileScopeFromPrompt(task.id);
      expect(paths).toEqual([
        "project.yml",
        "AtlasNotes.xcodeproj/**",
        "Tests/AtlasNotesMobileUITests/**",
        "Packages/MobileApp/**",
        "Sources/AtlasNotesMobileApp/**",
      ]);
    });
  });

  describe("repairOverlapBlocker", () => {
    async function writePrompt(taskId: string, scope: string[]) {
      const dir = join(rootDir, ".fusion", "tasks", taskId);
      await writeFile(
        join(dir, "PROMPT.md"),
        `# ${taskId}: repair fixture\n\n## File Scope\n\n${scope.map((entry) => `- \`${entry}\``).join("\n")}\n`,
      );
    }

    it("clears stale false-positive overlap blockers through the store API", async () => {
      const blocker = await store.createTask({ description: "Atlas blocker" });
      const target = await store.createTask({ description: "Fusion target" });
      await writePrompt(blocker.id, ["project.yml", "Tests/AtlasNotesMobileUITests/**"]);
      await writePrompt(target.id, ["packages/core/**", "packages/engine/**"]);
      await store.moveTask(blocker.id, "todo");
      await store.moveTask(blocker.id, "in-progress");
      await store.moveTask(target.id, "todo");
      await store.updateTask(target.id, { status: "queued", overlapBlockedBy: blocker.id });

      const result = await store.repairOverlapBlocker(target.id, { reason: "test" });

      expect(result).toMatchObject({ repaired: true, statusCleared: true, previousOverlapBlockedBy: blocker.id, reason: "repaired" });
      const repaired = await store.getTask(target.id);
      expect(repaired?.overlapBlockedBy).toBeUndefined();
      expect(repaired?.status).toBeUndefined();
      expect(repaired?.log.at(-1)?.action).toContain(`Repaired stale overlap blocker: cleared ${blocker.id}`);
    });

    it("returns structured not-found result instead of throwing", async () => {
      const result = await store.repairOverlapBlocker("FN-MISSING");

      expect(result).toMatchObject({
        taskId: "FN-MISSING",
        repaired: false,
        statusCleared: false,
        reason: "task-not-found",
      });
    });

    it("rejects repair when the stored blocker still overlaps", async () => {
      const blocker = await store.createTask({ description: "Fusion blocker" });
      const target = await store.createTask({ description: "Fusion target" });
      await writePrompt(blocker.id, ["packages/engine/**"]);
      await writePrompt(target.id, ["packages/engine/src/scheduler.ts"]);
      await store.moveTask(blocker.id, "todo");
      await store.moveTask(blocker.id, "in-progress");
      await store.moveTask(target.id, "todo");
      await store.updateTask(target.id, { status: "queued", overlapBlockedBy: blocker.id });

      const result = await store.repairOverlapBlocker(target.id);

      expect(result).toMatchObject({ repaired: false, statusCleared: false, reason: "scopes-still-overlap", currentOverlapBlockedBy: blocker.id });
      const unchanged = await store.getTask(target.id);
      expect(unchanged?.overlapBlockedBy).toBe(blocker.id);
      expect(unchanged?.status).toBe("queued");
    });

    it("reroutes stale overlap blockers to another current overlap", async () => {
      const stale = await store.createTask({ description: "stale blocker" });
      const current = await store.createTask({ description: "current blocker" });
      const target = await store.createTask({ description: "target" });
      await writePrompt(stale.id, ["packages/core/**"]);
      await writePrompt(current.id, ["packages/engine/**"]);
      await writePrompt(target.id, ["packages/engine/src/scheduler.ts"]);
      await store.moveTask(stale.id, "todo");
      await store.moveTask(current.id, "todo");
      await store.moveTask(current.id, "in-progress");
      await store.moveTask(target.id, "todo");
      await store.updateTask(target.id, { status: "queued", overlapBlockedBy: stale.id });

      const result = await store.repairOverlapBlocker(target.id);

      expect(result).toMatchObject({ repaired: true, statusCleared: false, reason: "rerouted-to-current-overlap", currentOverlapBlockedBy: current.id });
      const rerouted = await store.getTask(target.id);
      expect(rerouted?.overlapBlockedBy).toBe(current.id);
      expect(rerouted?.status).toBe("queued");
    });
  });

  describe("FN-5216 File Scope sanitization on copy paths", () => {
    const validScopeEntry = "packages/cli/src/extension.ts";
    const invalidScopeEntries = [
      "pr/create",
      "pr/refresh",
      "listBranches",
      "listRepoLabels",
      "listAssignableUsers",
      "getRepoMetadata",
      "baseUrl",
      "classifyGhError",
      ".fusion/tasks/FN-5149/",
      "fn_task_document_write",
    ];

    const buildLegacyPrompt = (taskId: string) => `# ${taskId}: Legacy file scope

## Mission

Keep the tool names \`pr/create\` and \`classifyGhError\` in this section.

## File Scope

- \`${validScopeEntry}\`
${invalidScopeEntries.map((entry) => `- \`${entry}\``).join("\n")}

## Steps

### Step 0: Preflight
- [ ] Mention \`fn_task_document_write\` outside File Scope
`;

    it("FN-5216 duplicateTask sanitizes invalid File Scope entries without touching other backticks", async () => {
      const task = await store.createTask({ description: "duplicate legacy scope" });
      const sourcePromptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(sourcePromptPath, buildLegacyPrompt(task.id));

      const duplicated = await store.duplicateTask(task.id);
      const duplicatedPromptPath = join(rootDir, ".fusion", "tasks", duplicated.id, "PROMPT.md");
      const duplicatedPrompt = await readFile(duplicatedPromptPath, "utf-8");

      expect(duplicatedPrompt).toContain(`- \`${validScopeEntry}\``);
      for (const entry of invalidScopeEntries) {
        expect(duplicatedPrompt).not.toContain(`- \`${entry}\``);
      }
      expect(duplicatedPrompt).toContain("Keep the tool names `pr/create` and `classifyGhError` in this section.");
      expect(duplicatedPrompt).toContain("- [ ] Mention `fn_task_document_write` outside File Scope");
      await expect(store.parseFileScopeFromPrompt(duplicated.id)).resolves.toEqual([validScopeEntry]);
    });

    it("FN-5216 restoreFromArchive sanitizes invalid File Scope entries on unarchive", async () => {
      const task = await store.createTask({ description: "restore legacy scope" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      await writeFile(promptPath, buildLegacyPrompt(task.id));

      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.moveTask(task.id, "done");
      await store.archiveTask(task.id, true);
      const restored = await store.unarchiveTask(task.id);
      const restoredPromptPath = join(rootDir, ".fusion", "tasks", restored.id, "PROMPT.md");
      const restoredPrompt = await readFile(restoredPromptPath, "utf-8");

      expect(restoredPrompt).toContain(`- \`${validScopeEntry}\``);
      for (const entry of invalidScopeEntries) {
        expect(restoredPrompt).not.toContain(`- \`${entry}\``);
      }
      expect(restoredPrompt).toContain("Keep the tool names `pr/create` and `classifyGhError` in this section.");
      await expect(store.parseFileScopeFromPrompt(restored.id)).resolves.toEqual([validScopeEntry]);
    });
  });

  describe("File Scope validation at write time", () => {
    it("FN-5216 createTask rejects invalid File Scope entries and rolls back", async () => {
      const badPrompt = `# Bad prompt\n\n## File Scope\n\n- \`packages/core/src/store.ts\`\n- \`origin/fusion/fn-4280\`\n`;

      await expect(store.createTaskWithReservedId({ description: "bad create" }, { taskId: "FN-999", prompt: badPrompt }))
        .rejects.toBeInstanceOf(InvalidFileScopeError);

      await expect(store.getTask("FN-999")).rejects.toThrow(/not found/i);
      expect(existsSync(join(rootDir, ".fusion", "tasks", "FN-999"))).toBe(false);
    });

    it("FN-5216 updateTask rejects invalid File Scope prompt and preserves existing PROMPT.md", async () => {
      const task = await store.createTask({ description: "update scope" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      const originalPrompt = await readFile(promptPath, "utf-8");
      const invalidPrompt = `# ${task.id}: invalid\n\n## File Scope\n\n- \`refs/heads/main\`\n`;

      await expect(store.updateTask(task.id, { prompt: invalidPrompt }))
        .rejects.toBeInstanceOf(InvalidFileScopeError);

      expect(await readFile(promptPath, "utf-8")).toBe(originalPrompt);
    });

    it("updateTask accepts valid File Scope prompt", async () => {
      const task = await store.createTask({ description: "update scope valid" });
      const promptPath = join(rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
      const validPrompt = `# ${task.id}: valid\n\n## File Scope\n\n- \`packages/core/src/store.ts\`\n- \`packages/core/*\`\n`;

      await store.updateTask(task.id, { prompt: validPrompt });
      expect(await readFile(promptPath, "utf-8")).toBe(validPrompt);
    });
  });

});
