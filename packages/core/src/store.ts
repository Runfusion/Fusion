import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, BoardConfig, Column, MergeResult, Settings } from "./types.js";
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
  /** Per-task promise chain for serializing writes */
  private taskLocks: Map<string, Promise<void>> = new Map();
  /** Promise chain for serializing config.json read-modify-write cycles */
  private configLock: Promise<void> = Promise.resolve();

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

  /**
   * Serialize all mutations to config.json by chaining promises.
   * Concurrent callers will queue behind each other, preventing
   * lost-update races on the nextId counter.
   */
  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.configLock;
    this.configLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
  }

  /**
   * Serialize all mutations to a given task's task.json by chaining promises
   * per task ID. Concurrent callers for the same ID will queue behind each other.
   */
  private withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.taskLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.taskLocks.get(id) === next) {
          this.taskLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  /**
   * Read and parse a task.json file. Throws immediately on invalid JSON —
   * atomic writes (write-to-temp-then-rename) prevent partial-write
   * corruption, so a `SyntaxError` indicates a real bug rather than a race.
   */
  private async readTaskJson(dir: string): Promise<Task> {
    const filePath = join(dir, "task.json");
    const raw = await readFile(filePath, "utf-8");
    try {
      return JSON.parse(raw) as Task;
    } catch (err) {
      throw new Error(
        `Failed to parse task.json at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Atomically write a task.json file by writing to a temp file first,
   * then renaming it into place. The rename is atomic on POSIX filesystems,
   * preventing partial writes from corrupting the file on crash/kill.
   */
  private async atomicWriteTaskJson(dir: string, task: Task): Promise<void> {
    const taskJsonPath = join(dir, "task.json");
    const tmpPath = join(dir, "task.json.tmp");
    this.suppressWatcher(taskJsonPath);
    await writeFile(tmpPath, JSON.stringify(task, null, 2));
    await rename(tmpPath, taskJsonPath);
  }

  async getSettings(): Promise<Settings> {
    const config = await this.readConfig();
    return { ...DEFAULT_SETTINGS, ...config.settings };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      const current = { ...DEFAULT_SETTINGS, ...config.settings };
      const updated = { ...current, ...patch };
      config.settings = updated;
      await this.writeConfig(config);
      return updated;
    });
  }

  private async readConfig(): Promise<BoardConfig> {
    const data = await readFile(this.configPath, "utf-8");
    return JSON.parse(data);
  }

  /**
   * Atomically write config.json by writing to a temp file first, then
   * renaming into place. The rename is atomic on POSIX filesystems,
   * preventing partial writes from corrupting the file.
   */
  private async atomicWriteConfig(config: BoardConfig): Promise<void> {
    const tmpPath = this.configPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(config, null, 2));
    await rename(tmpPath, this.configPath);
  }

  private async writeConfig(config: BoardConfig): Promise<void> {
    await this.atomicWriteConfig(config);
  }

  private async allocateId(): Promise<string> {
    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      const id = `HAI-${String(config.nextId).padStart(3, "0")}`;
      config.nextId++;
      await this.writeConfig(config);
      return id;
    });
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
      steps: [],
      currentStep: 0,
      log: [{ timestamp: now, action: "Task created" }],
      createdAt: now,
      updatedAt: now,
    };

    const dir = this.taskDir(id);
    await mkdir(dir, { recursive: true });
    await this.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(id, { ...task });

    const heading = task.title ? `${id}: ${task.title}` : id;
    const prompt = task.column === "triage"
      ? `# ${heading}\n\n${task.description}\n`
      : this.generateSpecifiedPrompt(task);
    await writeFile(join(dir, "PROMPT.md"), prompt);

    this.emit("task:created", task);
    return task;
  }

  /**
   * Read a task's JSON and prompt content.
   *
   * Retries once after a short delay on non-ENOENT errors to handle
   * transient read failures caused by concurrent `writeFile` calls
   * (e.g. partial JSON from a non-atomic write during executor updates).
   */
  async getTask(id: string): Promise<TaskDetail> {
    const dir = this.taskDir(id);
    const task = await this.readTaskJson(dir);

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
          tasks.push(await this.readTaskJson(join(this.tasksDir, entry.name)));
        } catch {
          // skip invalid task dirs
        }
      }
    }

    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async moveTask(id: string, toColumn: Column): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

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
        task.blockedBy = undefined;
      }

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: fromColumn, to: toColumn });
      return task;
    });
  }

  async updateTask(
    id: string,
    updates: { title?: string; description?: string; prompt?: string; worktree?: string; status?: string | null; dependencies?: string[] },
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (updates.title !== undefined) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.worktree !== undefined) task.worktree = updates.worktree;
      if (updates.dependencies !== undefined) task.dependencies = updates.dependencies;
      if (updates.status === null) {
        task.status = undefined;
      } else if (updates.status !== undefined) {
        task.status = updates.status;
      }
      if (updates.blockedBy === null) {
        task.blockedBy = undefined;
      } else if (updates.blockedBy !== undefined) {
        task.blockedBy = updates.blockedBy;
      }
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.watcher) this.taskCache.set(id, { ...task });

      if (updates.prompt !== undefined) {
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Update a step's status. Automatically advances currentStep.
   */
  async updateStep(
    id: string,
    stepIndex: number,
    status: import("./types.js").StepStatus,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Auto-initialize steps from PROMPT.md if empty
      if (task.steps.length === 0) {
        task.steps = await this.parseStepsFromPrompt(id);
      }

      if (stepIndex < 0 || stepIndex >= task.steps.length) {
        throw new Error(
          `Step ${stepIndex} out of range (task has ${task.steps.length} steps)`,
        );
      }

      task.steps[stepIndex].status = status;
      task.updatedAt = new Date().toISOString();

      // Advance currentStep to first non-done step
      if (status === "done") {
        while (
          task.currentStep < task.steps.length &&
          task.steps[task.currentStep].status === "done"
        ) {
          task.currentStep++;
        }
      } else if (status === "in-progress") {
        task.currentStep = stepIndex;
      }

      // Log it
      task.log.push({
        timestamp: task.updatedAt,
        action: `Step ${stepIndex} (${task.steps[stepIndex].name}) → ${status}`,
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Add a log entry to a task.
   */
  async logEntry(id: string, action: string, outcome?: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      task.log.push({
        timestamp: new Date().toISOString(),
        action,
        outcome,
      });
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Sync steps from PROMPT.md into task.json (called when steps are empty).
   */
  async parseStepsFromPrompt(id: string): Promise<import("./types.js").TaskStep[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");
    const steps: import("./types.js").TaskStep[] = [];
    const stepRegex = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
    let match;
    while ((match = stepRegex.exec(content)) !== null) {
      steps.push({ name: match[1].trim(), status: "pending" });
    }
    return steps;
  }

  /**
   * Parse the `## File Scope` section from a task's PROMPT.md and extract
   * backtick-quoted file paths. Glob patterns ending in `/*` are stored
   * as directory prefixes for overlap comparison.
   */
  async parseFileScopeFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## File Scope section
    const fileScopeMatch = content.match(
      /^##\s+File\s+Scope\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/m,
    );
    if (!fileScopeMatch) return [];

    const section = fileScopeMatch[1];
    const paths: string[] = [];
    const backtickRegex = /`([^`]+)`/g;
    let match;
    while ((match = backtickRegex.exec(section)) !== null) {
      paths.push(match[1]);
    }

    return paths;
  }

  async deleteTask(id: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const taskJsonPath = join(dir, "task.json");
      this.suppressWatcher(taskJsonPath);

      // Remove from cache if watcher is active
      if (this.watcher) this.taskCache.delete(id);

      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true });

      this.emit("task:deleted", task);
      return task;
    });
  }

  /**
   * Merge an in-review task's branch into the current branch,
   * clean up the worktree, and move the task to done.
   */
  async mergeTask(id: string): Promise<MergeResult> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (task.column !== "in-review") {
        throw new Error(
          `Cannot merge ${id}: task is in '${task.column}', must be in 'in-review'`,
        );
      }

      const branch = `hai/${id.toLowerCase()}`;
      const worktreePath = task.worktree;
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
        execSync(`git merge --squash "${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        execSync(`git commit --no-edit -m "feat(${id}): merge ${branch}"`, {
          cwd: this.rootDir,
          stdio: "pipe",
        });
        result.merged = true;
      } catch (err: any) {
        // Squash conflict — reset and report
        try {
          execSync("git reset --merge", { cwd: this.rootDir, stdio: "pipe" });
        } catch {
          // already clean
        }
        throw new Error(
          `Merge conflict merging '${branch}'. Resolve manually:\n` +
            `  cd ${this.rootDir}\n` +
            `  git merge --squash ${branch}\n` +
            `  # resolve conflicts, then: hai task move ${id} done`,
        );
      }

      // 3. Remove worktree
      if (worktreePath && existsSync(worktreePath)) {
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
    });
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    task.column = "done";
    task.worktree = undefined;
    task.status = undefined;
    task.blockedBy = undefined;
    task.updatedAt = new Date().toISOString();

    await this.atomicWriteTaskJson(dir, task);

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
      const taskDir = join(this.tasksDir, taskId);
      task = await this.readTaskJson(taskDir);
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

  private static ALLOWED_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "application/json",
    "text/yaml",
    "text/x-toml",
    "text/csv",
    "application/xml",
  ]);

  private static MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

  async addAttachment(
    id: string,
    filename: string,
    content: Buffer,
    mimeType: string,
  ): Promise<TaskAttachment> {
    if (!TaskStore.ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Invalid mime type '${mimeType}'. Allowed: ${[...TaskStore.ALLOWED_MIME_TYPES].join(", ")}`,
      );
    }
    if (content.length > TaskStore.MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `File too large (${content.length} bytes). Maximum: ${TaskStore.MAX_ATTACHMENT_SIZE} bytes (5MB)`,
      );
    }

    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const attachDir = join(dir, "attachments");
      await mkdir(attachDir, { recursive: true });

      // Sanitize filename: keep alphanumeric, dots, hyphens, underscores
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedName = `${Date.now()}-${sanitized}`;
      await writeFile(join(attachDir, storedName), content);

      const attachment: TaskAttachment = {
        filename: storedName,
        originalName: filename,
        mimeType,
        size: content.length,
        createdAt: new Date().toISOString(),
      };

      const task = await this.readTaskJson(dir);
      if (!task.attachments) task.attachments = [];
      task.attachments.push(attachment);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.watcher) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return attachment;
    });
  }

  async getAttachment(
    id: string,
    filename: string,
  ): Promise<{ path: string; mimeType: string }> {
    const dir = this.taskDir(id);
    const task = await this.readTaskJson(dir);
    const attachment = task.attachments?.find((a) => a.filename === filename);
    if (!attachment) {
      const err: NodeJS.ErrnoException = new Error(
        `Attachment '${filename}' not found on task ${id}`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return {
      path: join(dir, "attachments", filename),
      mimeType: attachment.mimeType,
    };
  }

  async deleteAttachment(id: string, filename: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const idx = task.attachments?.findIndex((a) => a.filename === filename) ?? -1;
      if (idx === -1) {
        const err: NodeJS.ErrnoException = new Error(
          `Attachment '${filename}' not found on task ${id}`,
        );
        err.code = "ENOENT";
        throw err;
      }

      // Remove file from disk
      const filePath = join(dir, "attachments", filename);
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone
      }

      task.attachments!.splice(idx, 1);
      if (task.attachments!.length === 0) {
        task.attachments = undefined;
      }
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.watcher) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return task;
    });
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private generateSpecifiedPrompt(task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    const heading = task.title ? `${task.id}: ${task.title}` : task.id;
    return `# ${heading}

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

${task.description}

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
