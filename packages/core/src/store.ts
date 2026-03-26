import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, BoardConfig, Column, MergeResult, Settings } from "./types.js";
import { VALID_TRANSITIONS, DEFAULT_SETTINGS } from "./types.js";

export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task];
  "task:merged": [result: MergeResult];
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  private haiDir: string;
  private tasksDir: string;
  private configPath: string;

  /** File-system watcher instance */
  private watcher: FSWatcher | null = null;
  /** In-memory cache of tasks for diffing watcher events */
  private taskCache: Map<string, Task> = new Map();
  /** Paths recently written by in-process mutations (suppresses duplicate events) */
  private recentlyWritten: Set<string> = new Set();
  /** Pending debounce timers keyed by task ID */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Debounce interval in ms */
  private debounceMs = 150;

  constructor(private rootDir: string) {
    super();
    this.haiDir = join(rootDir, ".hai");
    this.tasksDir = join(this.haiDir, "tasks");
    this.configPath = join(this.haiDir, "config.json");
  }

  async init(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    if (!existsSync(this.configPath)) {
      await this.writeConfig({ nextId: 1 });
    }
  }

  async getSettings(): Promise<Settings> {
    const config = await this.readConfig();
    return { ...DEFAULT_SETTINGS, ...config.settings };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const config = await this.readConfig();
    const current = { ...DEFAULT_SETTINGS, ...config.settings };
    const updated = { ...current, ...patch };
    config.settings = updated;
    await this.writeConfig(config);
    return updated;
  }

  private async readConfig(): Promise<BoardConfig> {
    const data = await readFile(this.configPath, "utf-8");
    return JSON.parse(data);
  }

  private async writeConfig(config: BoardConfig): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  private async allocateId(): Promise<string> {
    const config = await this.readConfig();
    const id = `HAI-${String(config.nextId).padStart(3, "0")}`;
    config.nextId++;
    await this.writeConfig(config);
    return id;
  }

  private taskDir(id: string): string {
    return join(this.tasksDir, id);
  }

  async createTask(input: TaskCreateInput): Promise<Task> {
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const id = await this.allocateId();
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title: input.title || undefined,
      description: input.description,
      column: input.column || "triage",
      dependencies: input.dependencies || [],
      createdAt: now,
      updatedAt: now,
    };

    const dir = this.taskDir(id);
    await mkdir(dir, { recursive: true });
    const taskJsonPath = join(dir, "task.json");
    this.suppressWatcher(taskJsonPath);
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2));

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(id, { ...task });

    const heading = task.title || task.description;
    const prompt = task.column === "triage"
      ? `# ${id}: ${heading}\n\n${task.description}\n`
      : this.generateSpecifiedPrompt(task);
    await writeFile(join(dir, "PROMPT.md"), prompt);

    this.emit("task:created", task);
    return task;
  }

  async getTask(id: string): Promise<TaskDetail> {
    const dir = this.taskDir(id);
    const data = await readFile(join(dir, "task.json"), "utf-8");
    const task = JSON.parse(data) as Task;

    let prompt = "";
    const promptPath = join(dir, "PROMPT.md");
    if (existsSync(promptPath)) {
      prompt = await readFile(promptPath, "utf-8");
    }

    return { ...task, prompt };
  }

  async listTasks(): Promise<Task[]> {
    if (!existsSync(this.tasksDir)) return [];

    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const tasks: Task[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("HAI-")) {
        try {
          const data = await readFile(
            join(this.tasksDir, entry.name, "task.json"),
            "utf-8",
          );
          tasks.push(JSON.parse(data));
        } catch {
          // skip invalid task dirs
        }
      }
    }

    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async moveTask(id: string, toColumn: Column): Promise<Task> {
    const dir = this.taskDir(id);
    const data = await readFile(join(dir, "task.json"), "utf-8");
    const task = JSON.parse(data) as Task;

    const validTargets = VALID_TRANSITIONS[task.column];
    if (!validTargets.includes(toColumn)) {
      throw new Error(
        `Invalid transition: '${task.column}' → '${toColumn}'. ` +
          `Valid targets: ${validTargets.join(", ") || "none"}`,
      );
    }

    const fromColumn = task.column;
    task.column = toColumn;
    task.updatedAt = new Date().toISOString();

    // Clear transient fields when moving to done (matches moveToDone behavior)
    if (toColumn === "done") {
      task.status = undefined;
      task.worktree = undefined;
    }

    const taskJsonPath = join(dir, "task.json");
    this.suppressWatcher(taskJsonPath);
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2));

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(id, { ...task });

    this.emit("task:moved", { task, from: fromColumn, to: toColumn });
    return task;
  }

  async updateTask(
    id: string,
    updates: { title?: string; description?: string; prompt?: string; worktree?: string; status?: string | null },
  ): Promise<Task> {
    const dir = this.taskDir(id);
    const data = await readFile(join(dir, "task.json"), "utf-8");
    const task = JSON.parse(data) as Task;

    if (updates.title !== undefined) task.title = updates.title;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.worktree !== undefined) task.worktree = updates.worktree;
    if (updates.status === null) {
      task.status = undefined;
    } else if (updates.status !== undefined) {
      task.status = updates.status;
    }
    task.updatedAt = new Date().toISOString();

    const taskJsonPath = join(dir, "task.json");
    this.suppressWatcher(taskJsonPath);
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2));

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(id, { ...task });

    if (updates.prompt !== undefined) {
      await writeFile(join(dir, "PROMPT.md"), updates.prompt);
    }

    this.emit("task:updated", task);
    return task;
  }

  async deleteTask(id: string): Promise<Task> {
    const dir = this.taskDir(id);
    const data = await readFile(join(dir, "task.json"), "utf-8");
    const task = JSON.parse(data) as Task;

    const taskJsonPath = join(dir, "task.json");
    this.suppressWatcher(taskJsonPath);

    // Remove from cache if watcher is active
    if (this.watcher) this.taskCache.delete(id);

    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true });

    this.emit("task:deleted", task);
    return task;
  }

  /**
   * Merge an in-review task's branch into the current branch,
   * clean up the worktree, and move the task to done.
   */
  async mergeTask(id: string): Promise<MergeResult> {
    const dir = this.taskDir(id);
    const data = await readFile(join(dir, "task.json"), "utf-8");
    const task = JSON.parse(data) as Task;

    if (task.column !== "in-review") {
      throw new Error(
        `Cannot merge ${id}: task is in '${task.column}', must be in 'in-review'`,
      );
    }

    const branch = `hai/${id.toLowerCase()}`;
    const worktreePath = task.worktree || join(this.rootDir, ".worktrees", id);
    const result: MergeResult = {
      task,
      branch,
      merged: false,
      worktreeRemoved: false,
      branchDeleted: false,
    };

    // 1. Check the branch exists
    try {
      execSync(`git rev-parse --verify "${branch}"`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
    } catch {
      // No branch — might have been manually merged. Just move to done.
      result.error = `Branch '${branch}' not found — moving to done without merge`;
      await this.moveToDone(task, dir);
      result.task = { ...task, column: "done" };
      this.emit("task:merged", result);
      return result;
    }

    // 2. Merge the branch
    try {
      execSync(`git merge "${branch}" --no-edit`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      result.merged = true;
    } catch (err: any) {
      // Merge conflict — abort and report
      try {
        execSync("git merge --abort", { cwd: this.rootDir, stdio: "pipe" });
      } catch {
        // already clean
      }
      throw new Error(
        `Merge conflict merging '${branch}'. Resolve manually:\n` +
          `  cd ${this.rootDir}\n` +
          `  git merge ${branch}\n` +
          `  # resolve conflicts, then: hai task move ${id} done`,
      );
    }

    // 3. Remove worktree
    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        result.worktreeRemoved = true;
      } catch {
        // Non-fatal — worktree may already be gone
      }
    }

    // 4. Delete the branch
    try {
      execSync(`git branch -d "${branch}"`, {
        cwd: this.rootDir,
        stdio: "pipe",
      });
      result.branchDeleted = true;
    } catch {
      // Branch might not be fully merged in some edge cases; try force
      try {
        execSync(`git branch -D "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        result.branchDeleted = true;
      } catch {
        // Non-fatal
      }
    }

    // 5. Move task to done
    await this.moveToDone(task, dir);
    result.task = { ...task, column: "done" };

    this.emit("task:merged", result);
    return result;
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    task.column = "done";
    task.worktree = undefined;
    task.status = undefined;
    task.updatedAt = new Date().toISOString();

    const taskJsonPath = join(dir, "task.json");
    this.suppressWatcher(taskJsonPath);
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2));

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(task.id, { ...task });

    this.emit("task:moved", { task, from: "in-review" as Column, to: "done" as Column });
  }

  // ── File-system watcher ───────────────────────────────────────────

  /**
   * Start watching the tasks directory for external changes.
   * Populates the in-memory cache and begins emitting events for
   * any task.json mutations made outside this process.
   */
  async watch(): Promise<void> {
    if (this.watcher) return; // already watching

    // Populate cache with current state
    const tasks = await this.listTasks();
    this.taskCache.clear();
    for (const task of tasks) {
      this.taskCache.set(task.id, { ...task });
    }

    try {
      this.watcher = watch(this.tasksDir, { recursive: true }, (_event, filename) => {
        if (typeof filename !== "string") return;
        this.handleFsChange(filename);
      });

      // Ignore watcher errors (e.g. dir deleted) – just stop watching
      this.watcher.on("error", () => {
        this.stopWatching();
      });
    } catch {
      // fs.watch may throw on some platforms; silently degrade
    }
  }

  /**
   * Stop the file-system watcher and clean up.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.taskCache.clear();
    this.recentlyWritten.clear();
  }

  /**
   * Mark a file path as recently written by an in-process mutation
   * so the watcher will skip it.
   */
  private suppressWatcher(filePath: string): void {
    this.recentlyWritten.add(filePath);
    setTimeout(() => {
      this.recentlyWritten.delete(filePath);
    }, this.debounceMs + 100);
  }

  /**
   * Handle a raw fs.watch callback. `filename` is relative to tasksDir.
   */
  private handleFsChange(filename: string): void {
    // We only care about task.json files
    const parts = filename.split(sep);
    // Normalize for platforms that may use forward slashes
    const normalizedParts = parts.length === 1 ? filename.split("/") : parts;

    if (normalizedParts.length < 2) return;
    const taskId = normalizedParts[0];
    const file = normalizedParts[normalizedParts.length - 1];
    if (file !== "task.json") return;
    if (!taskId.startsWith("HAI-")) return;

    const fullPath = join(this.tasksDir, taskId, "task.json");

    // Check suppression
    if (this.recentlyWritten.has(fullPath)) return;

    // Debounce per task ID
    const existing = this.debounceTimers.get(taskId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      taskId,
      setTimeout(() => {
        this.debounceTimers.delete(taskId);
        this.processTaskChange(taskId, fullPath).catch(() => {
          // Ignore errors (file may have been deleted mid-read)
        });
      }, this.debounceMs),
    );
  }

  /**
   * Read a task.json from disk and diff against the cache to emit the right event.
   */
  private async processTaskChange(taskId: string, filePath: string): Promise<void> {
    const cached = this.taskCache.get(taskId);

    if (!existsSync(filePath)) {
      // Task was deleted
      if (cached) {
        this.taskCache.delete(taskId);
        this.emit("task:deleted", cached);
      }
      return;
    }

    let task: Task;
    try {
      const data = await readFile(filePath, "utf-8");
      task = JSON.parse(data) as Task;
    } catch {
      return; // File not readable or invalid JSON
    }

    if (!cached) {
      // New task
      this.taskCache.set(taskId, { ...task });
      this.emit("task:created", task);
      return;
    }

    // Check for column change → task:moved
    if (cached.column !== task.column) {
      const from = cached.column;
      this.taskCache.set(taskId, { ...task });
      this.emit("task:moved", { task, from, to: task.column });
      return;
    }

    // Check for any other field change → task:updated
    if (JSON.stringify(cached) !== JSON.stringify(task)) {
      this.taskCache.set(taskId, { ...task });
      this.emit("task:updated", task);
    }
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private generateSpecifiedPrompt(task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    const heading = task.title || task.description;
    return `# ${task.id}: ${heading}

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

${task.description || task.title}

## Dependencies

${deps}

## Steps

### Step 1: Implementation

- [ ] Implement the required changes
- [ ] Verify changes work correctly

### Step 2: Testing & Verification

- [ ] All tests pass
- [ ] No regressions introduced

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation
- [ ] .DONE created

## Acceptance Criteria

- [ ] All steps complete
- [ ] All tests passing
`;
  }
}
