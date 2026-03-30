import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { existsSync, watch, type FSWatcher, readFileSync } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, AgentLogEntry, BoardConfig, Column, MergeResult, Settings } from "./types.js";
import { VALID_TRANSITIONS, DEFAULT_SETTINGS } from "./types.js";

export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: Column; to: Column }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task];
  "task:merged": [result: MergeResult];
  "settings:updated": [data: { settings: Settings; previous: Settings }];
  "agent:log": [entry: AgentLogEntry];
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  private kbDir: string;
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
    this.setMaxListeners(100);
    this.kbDir = join(rootDir, ".kb");
    this.tasksDir = join(this.kbDir, "tasks");
    this.configPath = join(this.kbDir, "config.json");
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
      const previous = { ...DEFAULT_SETTINGS, ...config.settings };
      const updated = { ...previous, ...patch };
      config.settings = updated;
      await this.writeConfig(config);
      this.emit("settings:updated", { settings: updated, previous });
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
      const prefix = config.settings?.taskPrefix || "KB";
      const id = `${prefix}-${String(config.nextId).padStart(3, "0")}`;
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
      columnMovedAt: now,
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
   * Duplicate an existing task, creating a fresh copy in triage.
   * Copies title and description with source reference, but resets all
   * execution state. The new task will be re-specified by the AI.
   */
  async duplicateTask(id: string): Promise<Task> {
    // Read the source task with its prompt
    const sourceTask = await this.getTask(id);

    // Allocate a new ID
    const newId = await this.allocateId();
    const now = new Date().toISOString();

    // Create new task with copied title/description, but fresh state
    const newTask: Task = {
      id: newId,
      title: sourceTask.title,
      description: `${sourceTask.description}\n\n(Duplicated from ${id})`,
      column: "triage",
      dependencies: [], // Fresh task should have no dependencies
      steps: [], // Reset execution state
      currentStep: 0,
      log: [{ timestamp: now, action: `Duplicated from ${id}` }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: now,
      // Explicitly NOT copied: worktree, status, blockedBy, paused, baseBranch,
      // attachments, steeringComments, prInfo, agent logs, size, reviewLevel
    };

    const newDir = this.taskDir(newId);
    await mkdir(newDir, { recursive: true });
    await this.atomicWriteTaskJson(newDir, newTask);

    // Copy source PROMPT.md content (the AI will re-specify it in triage)
    const sourcePrompt = sourceTask.prompt;
    await writeFile(join(newDir, "PROMPT.md"), sourcePrompt);

    // Update cache if watcher is active
    if (this.watcher) this.taskCache.set(newId, { ...newTask });

    this.emit("task:created", newTask);
    return newTask;
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
      if (entry.isDirectory() && /^[A-Z]+-\d+$/.test(entry.name)) {
        try {
          tasks.push(await this.readTaskJson(join(this.tasksDir, entry.name)));
        } catch {
          // skip invalid task dirs
        }
      }
    }

    return tasks.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });
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
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

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
    updates: { title?: string; description?: string; prompt?: string; worktree?: string; status?: string | null; dependencies?: string[]; blockedBy?: string | null; paused?: boolean; baseBranch?: string; size?: "S" | "M" | "L"; reviewLevel?: number; mergeRetries?: number; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null },
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (updates.title !== undefined) task.title = updates.title;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.worktree !== undefined) task.worktree = updates.worktree;
      // Detect new dependencies being added to a todo task → auto-move to triage
      let movedToTriage = false;
      if (updates.dependencies !== undefined) {
        const oldDeps = new Set(task.dependencies);
        const hasNewDeps = updates.dependencies.some((d) => !oldDeps.has(d));
        task.dependencies = updates.dependencies;

        if (hasNewDeps && task.column === "todo") {
          const fromColumn = task.column;
          task.column = "triage";
          task.status = undefined;
          task.columnMovedAt = new Date().toISOString();
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Moved to triage for re-specification — new dependency added",
          });
          movedToTriage = true;
        }
      }
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
      if (updates.paused !== undefined) task.paused = updates.paused || undefined;
      if (updates.baseBranch !== undefined) task.baseBranch = updates.baseBranch;
      if (updates.size !== undefined) task.size = updates.size;
      if (updates.reviewLevel !== undefined) task.reviewLevel = updates.reviewLevel;
      if (updates.mergeRetries !== undefined) task.mergeRetries = updates.mergeRetries;
      if (updates.modelProvider === null) {
        task.modelProvider = undefined;
      } else if (updates.modelProvider !== undefined) {
        task.modelProvider = updates.modelProvider;
      }
      if (updates.modelId === null) {
        task.modelId = undefined;
      } else if (updates.modelId !== undefined) {
        task.modelId = updates.modelId;
      }
      if (updates.validatorModelProvider === null) {
        task.validatorModelProvider = undefined;
      } else if (updates.validatorModelProvider !== undefined) {
        task.validatorModelProvider = updates.validatorModelProvider;
      }
      if (updates.validatorModelId === null) {
        task.validatorModelId = undefined;
      } else if (updates.validatorModelId !== undefined) {
        task.validatorModelId = updates.validatorModelId;
      }
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.watcher) this.taskCache.set(id, { ...task });

      if (updates.prompt !== undefined) {
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }

      if (movedToTriage) {
        this.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column });
      }
      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Pause or unpause a task. Paused tasks are excluded from all automated
   * agent and scheduler interaction. Logs the action and emits `task:updated`.
   */
  async pauseTask(id: string, paused: boolean): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      task.paused = paused || undefined;
      // When pausing an in-progress task, set status so the UI can show the state.
      // When unpausing, clear the "paused" status.
      if (task.column === "in-progress") {
        task.status = paused ? "paused" : undefined;
      }
      const now = new Date().toISOString();
      task.updatedAt = now;
      task.log.push({
        timestamp: now,
        action: paused ? "Task paused" : "Task unpaused",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.watcher) this.taskCache.set(id, { ...task });

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
   * Parse the `## Dependencies` section from a task's PROMPT.md and extract
   * task IDs from lines matching `- **Task:** {ID}` (where ID is `[A-Z]+-\d+`).
   *
   * Returns an empty array if the section says `- **None**`, has no task
   * references, or if the section/file doesn't exist.
   *
   * @param id - The task ID whose PROMPT.md to parse
   * @returns Array of dependency task IDs (e.g. `["KB-001", "KB-002"]`)
   */
  async parseDependenciesFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## Dependencies section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+Dependencies\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const ids: string[] = [];
    const taskIdRegex = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm;
    let match;
    while ((match = taskIdRegex.exec(section)) !== null) {
      ids.push(match[1]);
    }

    return ids;
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

    // Find the ## File Scope section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+File\s+Scope\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
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

      const branch = `kb/${id.toLowerCase()}`;
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
            `  # resolve conflicts, then: kb task move ${id} done`,
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

  /**
   * Archive a done task (move from done → archived).
   * Logs the action and emits `task:moved` event.
   */
  async archiveTask(id: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (task.column !== "done") {
        throw new Error(
          `Cannot archive ${id}: task is in '${task.column}', must be in 'done'`,
        );
      }

      task.column = "archived";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task archived",
      });

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: "done" as Column, to: "archived" as Column });
      return task;
    });
  }

  /**
   * Unarchive an archived task (move from archived → done).
   * Logs the action and emits `task:moved` event.
   */
  async unarchiveTask(id: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (task.column !== "archived") {
        throw new Error(
          `Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`,
        );
      }

      task.column = "done";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task unarchived",
      });

      await this.atomicWriteTaskJson(dir, task);

      // Update cache if watcher is active
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: "archived" as Column, to: "done" as Column });
      return task;
    });
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    task.column = "done";
    task.worktree = undefined;
    task.status = undefined;
    task.blockedBy = undefined;
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;

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
    if (!/^[A-Z]+-\d+$/.test(taskId)) return;

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

  /**
   * Append an agent log entry to the task's agent log file (JSONL format).
   * Each entry is a single JSON line appended to `.kb/tasks/{ID}/agent.log`.
   * Also emits an `agent:log` event for live streaming.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param text - The text content (delta for "text"/"thinking", tool name for "tool"/"tool_result"/"tool_error")
   * @param type - The entry type discriminator
   * @param detail - Optional human-readable summary (tool args, result summary, or error message)
   * @param agent - Optional agent role that produced this entry
   */
  async appendAgentLog(
    taskId: string,
    text: string,
    type: AgentLogEntry["type"],
    detail?: string,
    agent?: AgentLogEntry["agent"],
  ): Promise<void> {
    const entry: AgentLogEntry = {
      timestamp: new Date().toISOString(),
      taskId,
      text,
      type,
      ...(detail !== undefined && { detail }),
      ...(agent !== undefined && { agent }),
    };
    const dir = this.taskDir(taskId);
    const logPath = join(dir, "agent.log");
    await appendFile(logPath, JSON.stringify(entry) + "\n");
    this.emit("agent:log", entry);
  }

  /**
   * Add a steering comment to a task.
   * Steering comments are user-provided feedback injected into the AI execution context.
   */
  async addSteeringComment(
    id: string,
    text: string,
    author: "user" | "agent" = "user",
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Generate unique ID: timestamp + random suffix for collision resistance
      const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const comment: import("./types.js").SteeringComment = {
        id: commentId,
        text,
        createdAt: new Date().toISOString(),
        author,
      };

      if (!task.steeringComments) {
        task.steeringComments = [];
      }
      task.steeringComments.push(comment);
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: "Steering comment added",
        outcome: `by ${author}`,
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.watcher) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Update or clear PR information for a task.
   * Updates task.json atomically and emits `task:updated` event.
   *
   * @param id - The task ID
   * @param prInfo - The PR info to set, or null to clear
   * @returns The updated task
   */
  async updatePrInfo(
    id: string,
    prInfo: import("./types.js").PrInfo | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const prevPrNumber = task.prInfo?.number;
      const prevPrStatus = task.prInfo?.status;

      if (prInfo) {
        task.prInfo = prInfo;
        task.log.push({
          timestamp: new Date().toISOString(),
          action: "PR linked",
          outcome: `PR #${prInfo.number}: ${prInfo.url}`,
        });
      } else {
        task.prInfo = undefined;
        if (prevPrNumber) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "PR unlinked",
            outcome: `PR #${prevPrNumber} removed`,
          });
        }
      }

      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.watcher) this.taskCache.set(id, { ...task });

      // Only emit if PR info actually changed
      if (prevPrNumber !== prInfo?.number || prevPrStatus !== prInfo?.status) {
        this.emit("task:updated", task);
      }

      return task;
    });
  }

  /**
   * Read all historical agent log entries for a task from its agent log file.
   * Returns entries in chronological order (oldest first).
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @returns Array of agent log entries, empty if no log file exists
   */
  async getAgentLogs(taskId: string): Promise<AgentLogEntry[]> {
    const dir = this.taskDir(taskId);
    const logPath = join(dir, "agent.log");
    if (!existsSync(logPath)) return [];
    const content = await readFile(logPath, "utf-8");
    const entries: AgentLogEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AgentLogEntry);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private generateSpecifiedPrompt(task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    // Get current settings to check for ntfy configuration
    const settings = this.getSettingsSync();
    const notificationsSection =
      settings.ntfyEnabled && settings.ntfyTopic
        ? `\n## Notifications\n\nntfy topic: \`${settings.ntfyTopic}\`\n`
        : "";

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
${notificationsSection}`;
  }

  /**
   * Synchronous version of getSettings for internal use.
   * Returns cached settings or default settings if not loaded.
   */
  private getSettingsSync(): Settings {
    // Since we can't easily make generateSpecifiedPrompt async,
    // we read settings synchronously from the file.
    // The settings file is read during init and on each update,
    // so this should be reasonably up-to-date for prompt generation.
    try {
      const config = JSON.parse(readFileSync(this.configPath, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...config.settings };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
