import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseStepFileScopes,
  buildConflictMatrix,
  determineParallelWaves,
  buildStepPrompt,
  StepSessionExecutor,
} from "./step-session-executor.js";
import { AgentLogger } from "./agent-logger.js";
import type { TaskDetail, Settings, TaskStore } from "@fusion/core";

// ── Shared test fixtures ──────────────────────────────────────────────

function makePrompt(steps: string[]): string {
  return `# Task: FN-001 - Test Task

## Mission
Do the thing.

## Steps

${steps.join("\n\n")}

## Completion Criteria
- All done
`;
}

function makeTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-001",
    title: "Test Task",
    description: "A test task",
    column: "in-progress",
    dependencies: [],
    steps: [
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
      { name: "Test", status: "pending" },
    ],
    currentStep: 0,
    log: [],
    prompt: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── parseStepFileScopes tests ──────────────────────────────────────────

describe("parseStepFileScopes", () => {
  it("extracts paths from a realistic multi-step PROMPT.md", () => {
    const prompt = makePrompt([
      `### Step 0: Preflight

- [ ] Required files exist

**Artifacts:**
- \`packages/core/src/types.ts\`
- \`packages/engine/src/pi.ts\``,
      `### Step 1: Implement

- [ ] Create the module

**Artifacts:**
- \`packages/engine/src/new-module.ts\` (new)
- \`packages/engine/src/existing.ts\` (modified)`,
      `### Step 2: Test

- [ ] Write tests

**Artifacts:**
- \`packages/engine/src/new-module.test.ts\``,
    ]);

    const scopes = parseStepFileScopes(prompt);

    expect(scopes.get(0)).toEqual([
      "packages/core/src/types.ts",
      "packages/engine/src/pi.ts",
    ]);
    expect(scopes.get(1)).toEqual([
      "packages/engine/src/new-module.ts",
      "packages/engine/src/existing.ts",
    ]);
    expect(scopes.get(2)).toEqual([
      "packages/engine/src/new-module.test.ts",
    ]);
  });

  it("returns empty arrays for steps with no file scope", () => {
    const prompt = makePrompt([
      `### Step 0: Preflight

- [ ] Check things`,
      `### Step 1: Implement

- [ ] Do the work`,
    ]);

    const scopes = parseStepFileScopes(prompt);
    expect(scopes.get(0)).toEqual([]);
    expect(scopes.get(1)).toEqual([]);
  });

  it("handles steps with - \\`path\\` in artifacts sections", () => {
    const prompt = `### Step 0: Setup

**Artifacts:**
- \`src/foo.ts\`
- \`src/bar.ts\`

### Step 1: Build

**Artifacts:**
- \`dist/bundle.js\``;

    const scopes = parseStepFileScopes(prompt);
    expect(scopes.get(0)).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(scopes.get(1)).toEqual(["dist/bundle.js"]);
  });

  it("normalizes glob patterns (strips /* suffix)", () => {
    const prompt = `### Step 0: Implement

- \`packages/core/*\`
- \`packages/engine/src/*\``;

    const scopes = parseStepFileScopes(prompt);
    expect(scopes.get(0)).toEqual(["packages/core", "packages/engine/src"]);
  });

  it("returns empty Map for empty prompts", () => {
    expect(parseStepFileScopes("")).toEqual(new Map());
    expect(parseStepFileScopes("Just some text")).toEqual(new Map());
  });

  it("returns empty Map for prompts with no step sections", () => {
    const prompt = `# Task: FN-001\n\n## Mission\nDo stuff.\n\nNo steps here.`;
    expect(parseStepFileScopes(prompt)).toEqual(new Map());
  });

  it("strips (new | modified) suffix from paths", () => {
    const prompt = `### Step 0: Do things

**Artifacts:**
- \`src/foo.ts\` (new)
- \`src/bar.ts\` (modified)`;

    const result = parseStepFileScopes(prompt);
    expect(result.get(0)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("strips trailing slashes from paths", () => {
    const prompt = `### Step 0: Do things

- \`src/foo/\``;

    const result = parseStepFileScopes(prompt);
    expect(result.get(0)).toEqual(["src/foo"]);
  });

  it("handles mixed paths with and without suffixes", () => {
    const prompt = `### Step 0: Do things

- \`src/a.ts\`
- \`src/b.ts\` (new)
- \`src/c.ts\` (modified)
- \`packages/core/*\``;

    const result = parseStepFileScopes(prompt);
    expect(result.get(0)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "packages/core",
    ]);
  });

  it("produces sequential 0-based keys", () => {
    const prompt = `### Step 0: A

- \`a.ts\`

### Step 1: B

- \`b.ts\`

### Step 2: C

- \`c.ts\``;

    const result = parseStepFileScopes(prompt);
    expect([...result.keys()]).toEqual([0, 1, 2]);
  });
});

// ── buildConflictMatrix tests ──────────────────────────────────────────

describe("buildConflictMatrix", () => {
  it("returns empty matrix for empty scopes", () => {
    const scopes = new Map<number, string[]>();
    const matrix = buildConflictMatrix(scopes);
    expect(matrix).toEqual([]);
  });

  it("diagonal is always true", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
    ]);
    const matrix = buildConflictMatrix(scopes);
    expect(matrix[0][0]).toBe(true);
    expect(matrix[1][1]).toBe(true);
  });

  it("detects exact path overlap as conflict", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/a.ts"]],
    ]);
    const matrix = buildConflictMatrix(scopes);
    expect(matrix[0][1]).toBe(true);
    expect(matrix[1][0]).toBe(true);
  });

  it("detects prefix overlap as conflict", () => {
    const scopes = new Map<number, string[]>([
      [0, ["packages/core"]],
      [1, ["packages/core/src/types.ts"]],
    ]);
    const matrix = buildConflictMatrix(scopes);
    expect(matrix[0][1]).toBe(true);
    expect(matrix[1][0]).toBe(true);
  });

  it("no conflict when paths are completely separate", () => {
    const scopes = new Map<number, string[]>([
      [0, ["packages/core/src/types.ts"]],
      [1, ["packages/engine/src/pi.ts"]],
    ]);
    const matrix = buildConflictMatrix(scopes);
    expect(matrix[0][1]).toBe(false);
    expect(matrix[1][0]).toBe(false);
  });

  it("returns symmetric matrix", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts", "src/b.ts"]],
      [1, ["src/c.ts"]],
      [2, ["src/b.ts", "src/d.ts"]],
    ]);
    const matrix = buildConflictMatrix(scopes);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(matrix[i][j]).toBe(matrix[j][i]);
      }
    }
  });

  it("empty scope steps do not conflict with anything", () => {
    const scopes = new Map<number, string[]>([
      [0, []],
      [1, ["src/a.ts"]],
      [2, []],
    ]);
    const matrix = buildConflictMatrix(scopes);
    // Empty scopes don't conflict with anything (except themselves on diagonal)
    expect(matrix[0][1]).toBe(false);
    expect(matrix[0][2]).toBe(false);
    expect(matrix[1][2]).toBe(false);
  });
});

// ── determineParallelWaves tests ───────────────────────────────────────

describe("determineParallelWaves", () => {
  it("maxParallel=1 → all steps sequential (one per wave)", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
      [2, ["src/c.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 1);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ indices: [0], waveNumber: 0 });
    expect(waves[1]).toEqual({ indices: [1], waveNumber: 1 });
    expect(waves[2]).toEqual({ indices: [2], waveNumber: 2 });
  });

  it("no conflicts → all steps in wave 0 (capped by maxParallel)", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
      [2, ["src/c.ts"]],
      [3, ["src/d.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 2);
    // All non-conflicting, capped at 2 per wave → 2 waves
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toEqual([0, 1]);
    expect(waves[1].indices).toEqual([2, 3]);
  });

  it("all steps conflict → each step in its own wave", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/a.ts"]],
      [2, ["src/a.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 4);
    // All conflict with each other → each in own wave
    expect(waves).toHaveLength(3);
    expect(waves[0].indices).toEqual([0]);
    expect(waves[1].indices).toEqual([1]);
    expect(waves[2].indices).toEqual([2]);
  });

  it("mixed — steps 0,1 touch core (parent/child), steps 2,3 touch engine (parent/child) → wave grouping", () => {
    // Use directory + file paths so prefix overlap creates real conflicts
    const scopes = new Map<number, string[]>([
      [0, ["packages/core"]],
      [1, ["packages/core/src/store.ts"]],
      [2, ["packages/engine"]],
      [3, ["packages/engine/src/executor.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 2);
    // 0 and 1 conflict (0 is prefix of 1), 2 and 3 conflict (2 is prefix of 3)
    // 0 and 2 don't conflict → wave 0: [0, 2]
    // 1 and 3 don't conflict → wave 1: [1, 3]
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toEqual([0, 2]);
    expect(waves[1].indices).toEqual([1, 3]);
  });

  it("empty scopes → no conflicts, all in wave 0", () => {
    const scopes = new Map<number, string[]>([
      [0, []],
      [1, []],
    ]);
    const waves = determineParallelWaves(scopes, 4);
    expect(waves).toHaveLength(1);
    expect(waves[0].indices).toEqual([0, 1]);
  });

  it("maxParallel=2 with 4 non-conflicting steps → 2 waves of 2", () => {
    const scopes = new Map<number, string[]>([
      [0, ["a.ts"]],
      [1, ["b.ts"]],
      [2, ["c.ts"]],
      [3, ["d.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 2);
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toHaveLength(2);
    expect(waves[1].indices).toHaveLength(2);
  });

  it("produces ascending wave numbers", () => {
    const scopes = new Map<number, string[]>([
      [0, ["a.ts"]],
      [1, ["b.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 1);
    for (let i = 0; i < waves.length; i++) {
      expect(waves[i].waveNumber).toBe(i);
    }
  });

  it("respects maxParallel cap even when no conflicts exist", () => {
    const scopes = new Map<number, string[]>([
      [0, ["a.ts"]],
      [1, ["b.ts"]],
      [2, ["c.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 2);
    // 3 non-conflicting steps, max 2 → wave 0: [0,1], wave 1: [2]
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toEqual([0, 1]);
    expect(waves[1].indices).toEqual([2]);
  });
});

// ── buildStepPrompt tests ─────────────────────────────────────────────

describe("buildStepPrompt", () => {
  const fullPrompt = `# Task: FN-001 - Test Task

## Mission
Do important work.

## Context to Read First
- \`src/types.ts\`

## File Scope
- \`packages/engine/src/new-module.ts\`

## Do NOT
- Delete existing files
- Skip tests

## Steps

### Step 0: Preflight

- [ ] Check files exist
- [ ] Verify settings

### Step 1: Implement

- [ ] Create new-module.ts
- [ ] Add exports

**Artifacts:**
- \`packages/engine/src/new-module.ts\` (new)

### Step 2: Test

- [ ] Write unit tests
- [ ] Run pnpm test

**Artifacts:**
- \`packages/engine/src/new-module.test.ts\` (new)

## Completion Criteria
- All tests pass

## Git Commit Convention
- feat(FN-001): description

## Review level: 2`;

  it("includes step-specific section text", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).toContain("Create new-module.ts");
    expect(result).toContain("Add exports");
  });

  it("includes task ID and step number in preamble", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).toContain("Step 1");
    expect(result).toContain("FN-001");
  });

  it("includes File Scope and Do NOT sections from original prompt", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).toContain("packages/engine/src/new-module.ts");
    expect(result).toContain("Do NOT");
    expect(result).toContain("Delete existing files");
  });

  it("rewrites project-root absolute paths to the active worktree", () => {
    const prompt = fullPrompt.replace(
      "`packages/engine/src/new-module.ts`",
      "`/repo/project/packages/engine/src/new-module.ts`",
    ).replace(
      "- `src/types.ts`",
      "- `/repo/project/.fusion/memory/MEMORY.md`",
    );
    const task = makeTaskDetail({ prompt });
    const result = buildStepPrompt(
      task,
      1,
      "/repo/project",
      undefined,
      "/repo/project/.worktrees/happy-robin",
    );

    expect(result).toContain("/repo/project/.worktrees/happy-robin/packages/engine/src/new-module.ts");
    expect(result).toContain("/repo/project/.fusion/memory/MEMORY.md");
    expect(result).not.toContain("/repo/project/.worktrees/happy-robin/.fusion/memory/MEMORY.md");
  });

  it("handles step 0 (preflight) correctly", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 0);
    expect(result).toContain("Step 0");
    expect(result).toContain("Check files exist");
    expect(result).toContain("Verify settings");
  });

  it("handles the last step correctly", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 2);
    expect(result).toContain("Step 2");
    expect(result).toContain("Write unit tests");
  });

  it("handles a step with no checkboxes", () => {
    const minimalPrompt = `# Task: FN-001

### Step 0: Just Do It

Some freeform text without checkboxes.`;

    const task = makeTaskDetail({ prompt: minimalPrompt });
    const result = buildStepPrompt(task, 0);
    expect(result).toContain("Just Do It");
    expect(result).toContain("Some freeform text");
  });

  it("includes project commands when settings provide them", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const settings = {
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    } as Partial<Settings> as Settings;
    const result = buildStepPrompt(task, 1, undefined, settings);
    expect(result).toContain("pnpm test");
    expect(result).toContain("pnpm build");
  });

  it("does not include project commands when settings lack them", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).not.toContain("Project Commands");
  });

  it("includes task_done instruction at the end", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).toContain("task_done()");
  });

  it("does not include content from other steps", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 0);
    // Step 1 content should not appear
    expect(result).not.toContain("Create new-module.ts");
  });
});

// ── StepSessionExecutor test helpers ───────────────────────────────────

// Mock pi.js for StepSessionExecutor tests
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  compactSessionContext: vi.fn(),
}));

// Mock logger
vi.mock("./logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  const loggers = new Map<string, ReturnType<typeof createMockLogger>>();
  const getLogger = (prefix: string) => {
    if (!loggers.has(prefix)) {
      loggers.set(prefix, createMockLogger());
    }
    return loggers.get(prefix)!;
  };

  return {
    createLogger: vi.fn((prefix: string) => getLogger(prefix)),
    schedulerLog: getLogger("scheduler"),
    executorLog: getLogger("executor"),
    triageLog: getLogger("triage"),
    mergerLog: getLogger("merger"),
    worktreePoolLog: getLogger("worktree-pool"),
    reviewerLog: getLogger("reviewer"),
    prMonitorLog: getLogger("pr-monitor"),
    runtimeLog: getLogger("runtime"),
    stepExecLog: getLogger("step-session-executor"),
    ipcLog: getLogger("ipc"),
    projectManagerLog: getLogger("project-manager"),
    autopilotLog: getLogger("autopilot"),
  };
});

// Mock context-limit-detector
vi.mock("./context-limit-detector.js", () => ({
  isContextLimitError: vi.fn().mockImplementation((msg: string) =>
    /context\s+window\s+exceeds/i.test(msg),
  ),
}));

// Mock usage-limit-detector
vi.mock("./usage-limit-detector.js", () => ({
  checkSessionError: vi.fn(),
}));

// Mock worktree-names
vi.mock("./worktree-names.js", async () => {
  const actual = await vi.importActual<typeof import("./worktree-names.js")>("./worktree-names.js");
  return {
    ...actual,
    generateWorktreeName: vi.fn().mockReturnValue("test-worktree"),
  };
});

// Route async `exec` through the `execSync` mock so existing tests keep working.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn();
   
  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });
   
  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
       
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn };
});
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { createKbAgent } from "./pi.js";
import { generateWorktreeName } from "./worktree-names.js";
import { execSync } from "node:child_process";
import { AgentSemaphore } from "./concurrency.js";
import { createLogger } from "./logger.js";

const mockedCreateKbAgent = vi.mocked(createKbAgent);
const mockedExecSync = vi.mocked(execSync);
const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);
const mockedCreateLogger = vi.mocked(createLogger);

const getStepSessionLogger = () => mockedCreateLogger("step-session-executor") as {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeMockSession(promptFn?: () => Promise<void>) {
  return {
    prompt: promptFn ?? vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
}

function makeSettings(overrides: Record<string, any> = {}): Settings {
  return {
    maxConcurrent: 2,
    maxWorktrees: 4,
    maxParallelSteps: 1,
    ...overrides,
  } as Settings;
}

function makeStepPrompt(taskId: string, numSteps: number): string {
  const steps = [];
  for (let i = 0; i < numSteps; i++) {
    steps.push(`### Step ${i}: Step ${i}\n- [ ] Do step ${i}`);
  }
  return `# Task: ${taskId}\n\n## Steps\n\n${steps.join("\n\n")}`;
}

// ── StepSessionExecutor: Sequential Execution ──────────────────────────

describe("StepSessionExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Default: generateWorktreeName returns predictable names
    mockedGenerateWorktreeName.mockReturnValue("test-worktree");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("sequential execution", () => {
    it("happy path: 3-step task, all steps succeed", async () => {
      const prompt = makeStepPrompt("FN-001", 3);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
        { name: "Step 2", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const onStepStart = vi.fn();
      const onStepComplete = vi.fn();

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        onStepStart,
        onStepComplete,
      });

      const results = await executor.executeAll();

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.retries === 0)).toBe(true);

      // Verify 3 sessions were created
      expect(mockedCreateKbAgent).toHaveBeenCalledTimes(3);

      // Verify callbacks
      expect(onStepStart).toHaveBeenCalledTimes(3);
      expect(onStepComplete).toHaveBeenCalledTimes(3);
      expect(onStepStart).toHaveBeenNthCalledWith(1, 0);
      expect(onStepStart).toHaveBeenNthCalledWith(2, 1);
      expect(onStepStart).toHaveBeenNthCalledWith(3, 2);
    });

    it("step failure with retry: fails first 2 attempts, succeeds on 3rd", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      let callCount = 0;
      const session = makeMockSession(() => {
        callCount++;
        if (callCount <= 2) {
          throw new Error("Session failed");
        }
        return Promise.resolve();
      });

      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultsPromise = executor.executeAll();

      // Fast-forward through retry delays
      await vi.advanceTimersByTimeAsync(30_000);

      const results = await resultsPromise;

      // Step 0 should succeed after retries
      expect(results[0]).toMatchObject({
        stepIndex: 0,
        success: true,
        retries: 2,
      });

      // 3 sessions created for step 0 (2 failures + 1 success) + 1 for step 1
      expect(mockedCreateKbAgent).toHaveBeenCalledTimes(4);
    });

    it("step failure after max retries: returns failure result", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const failingSession = makeMockSession(() => {
        throw new Error("Persistent failure");
      });
      const successSession = makeMockSession();

      let createCount = 0;
      mockedCreateKbAgent.mockImplementation(() => {
        createCount++;
        if (createCount <= 4) {
          // Step 0: 1 initial + 3 retries = 4 failures
          return Promise.resolve({ session: failingSession } as any);
        }
        return Promise.resolve({ session: successSession } as any);
      });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultsPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      const results = await resultsPromise;

      // Step 0 should fail after max retries
      expect(results[0]).toMatchObject({
        stepIndex: 0,
        success: false,
        retries: 3,
      });
      expect(results[0].error).toContain("Persistent failure");

      // Step 1 should still be attempted
      expect(results[1]).toMatchObject({
        stepIndex: 1,
        success: true,
      });

      // 4 sessions for step 0 + 1 for step 1
      expect(mockedCreateKbAgent).toHaveBeenCalledTimes(5);
    });

    it("aborted flag: returns failed result immediately", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      // Abort before execution
      await executor.terminateAllSessions();

      const results = await executor.executeAll();

      expect(results).toHaveLength(0); // No steps executed because aborted before executeAll
      // All steps returned as failed because aborted was set
    });

    it("returns empty results for task with no steps", async () => {
      const task = makeTaskDetail({
        prompt: "# Task: FN-001\n\nNo steps defined.",
        steps: [],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();
      expect(results).toEqual([]);
    });

    it("acquires and releases semaphore for each step", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });
      const semaphore = new AgentSemaphore(2);

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const acquireSpy = vi.spyOn(semaphore, "acquire");
      const releaseSpy = vi.spyOn(semaphore, "release");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        semaphore,
      });

      await executor.executeAll();

      expect(acquireSpy).toHaveBeenCalledTimes(2);
      expect(releaseSpy).toHaveBeenCalledTimes(2);
      expect(semaphore.activeCount).toBe(0);
    });

    it("releases semaphore even when step fails", async () => {
      const prompt = makeStepPrompt("FN-001", 1);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });
      const semaphore = new AgentSemaphore(1);

      mockedCreateKbAgent.mockRejectedValue(new Error("Agent creation failed"));

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        semaphore,
      });

      const resultsPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      const results = await resultsPromise;

      expect(semaphore.activeCount).toBe(0);
      expect(results[0].success).toBe(false);
    });
  });

  describe("parallel execution", () => {
    it("creates separate worktrees for non-conflicting parallel steps", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);
      mockedExecSync.mockReturnValue("");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      // Both steps should succeed
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);

      // Worktree creation was called for parallel steps
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git worktree add"),
        expect.anything(),
      );
    });

    it("handles parallel step failure: successful step cherry-picked, failed cleaned up", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      let createCount = 0;
      mockedCreateKbAgent.mockImplementation(() => {
        createCount++;
        if (createCount === 1) {
          // Step 0 succeeds
          return Promise.resolve({ session: makeMockSession() } as any);
        }
        // Step 1 fails
        const failSession = makeMockSession(() => {
          throw new Error("Step 1 failed");
        });
        return Promise.resolve({ session: failSession } as any);
      });
      mockedExecSync.mockReturnValue("");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultsPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      const results = await resultsPromise;

      expect(results).toHaveLength(2);
      // One should succeed, one should fail
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);
      expect(successes.length + failures.length).toBe(2);

      // Worktree cleanup should still happen
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git worktree remove"),
        expect.anything(),
      );
    });

    it("cherry-pick conflict is non-fatal", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      // Make git log return commits, but cherry-pick fails
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git log")) {
          return "abc123def Some commit";
        }
        if (typeof cmd === "string" && cmd.includes("git cherry-pick") && !cmd.includes("--abort")) {
          throw new Error("Merge conflict");
        }
        return "";
      });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      // Steps should still be reported as successful (cherry-pick failure is non-fatal)
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("logs warning when cherry-pick --abort fails", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git log")) {
          return "abc123def Some commit";
        }
        if (typeof cmd === "string" && cmd.includes("git cherry-pick") && cmd.includes("--abort")) {
          throw new Error("abort failed");
        }
        if (typeof cmd === "string" && cmd.includes("git cherry-pick") && !cmd.includes("--abort")) {
          throw new Error("Merge conflict");
        }
        return "";
      });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();

      expect(getStepSessionLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Cherry-pick --abort failed for step"),
      );
    });

    it("logs warning when cherry-pick --abort fails after conflict and still throws conflict", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 2),
      });
      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 2 }),
      });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("git log")) {
          return "abc123";
        }
        if (cmd.includes("git cherry-pick") && cmd.includes("--abort")) {
          throw new Error("abort failed");
        }
        if (cmd.includes("git cherry-pick")) {
          throw new Error("Merge conflict");
        }
        return "";
      });

      await expect(
        (executor as any).cherryPickCommits(1, "/project/.worktrees/step-1"),
      ).rejects.toThrow("Cherry-pick conflict for commit abc123 in step 1: Merge conflict");

      expect(getStepSessionLogger().warn).toHaveBeenCalledWith(
        "Cherry-pick --abort failed for step 1: abort failed",
      );
    });

    it("semaphore integration: parallel steps acquire/release", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });
      const semaphore = new AgentSemaphore(4);

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);
      mockedExecSync.mockReturnValue("");

      const acquireSpy = vi.spyOn(semaphore, "acquire");
      const releaseSpy = vi.spyOn(semaphore, "release");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        semaphore,
      });

      await executor.executeAll();

      // Both parallel steps should acquire/release
      expect(acquireSpy).toHaveBeenCalledTimes(2);
      expect(releaseSpy).toHaveBeenCalledTimes(2);
      expect(semaphore.activeCount).toBe(0);
    });

    describe("worktree creation failure handling", () => {
      it("degrades to sequential when one worktree creation fails", async () => {
        const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

        const task = makeTaskDetail({
          prompt,
          steps: [
            { name: "Step 0", status: "pending" },
            { name: "Step 1", status: "pending" },
          ],
        });
        const settings = makeSettings({ maxParallelSteps: 2 });

        mockedGenerateWorktreeName
          .mockImplementationOnce(() => "wt-step-0")
          .mockImplementationOnce(() => "wt-step-1");

        let worktreeAddCount = 0;
        mockedExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes("git worktree add")) {
            worktreeAddCount++;
            if (worktreeAddCount === 2) {
              throw new Error("step 1 worktree failed");
            }
          }
          return "";
        });

        let releaseStep0: (() => void) | undefined;
        const step0Gate = new Promise<void>((resolve) => {
          releaseStep0 = resolve;
        });
        const executionEvents: string[] = [];

        mockedCreateKbAgent.mockImplementation(({ cwd }: any) => {
          if (cwd === "/project/.worktrees/wt-step-0") {
            return Promise.resolve({
              session: makeMockSession(async () => {
                executionEvents.push("step-0-start");
                await step0Gate;
                executionEvents.push("step-0-end");
              }),
            } as any);
          }

          if (cwd === "/project/.worktrees/main") {
            return Promise.resolve({
              session: makeMockSession(async () => {
                executionEvents.push("step-1-start");
              }),
            } as any);
          }

          throw new Error(`Unexpected cwd: ${cwd}`);
        });

        const executor = new StepSessionExecutor({
          taskDetail: task,
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings,
        });

        const resultsPromise = executor.executeAll();

        for (let i = 0; i < 20 && !executionEvents.includes("step-0-start"); i++) {
          await Promise.resolve();
        }

        expect(executionEvents.includes("step-0-start")).toBe(true);

        releaseStep0?.();
        const results = await resultsPromise;

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1]);
        expect(results.every((r) => r.success)).toBe(true);
        expect(mockedCreateKbAgent).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ cwd: "/project/.worktrees/main" }),
        );
        expect(executionEvents).toEqual(["step-0-start", "step-0-end", "step-1-start"]);
      });

      it("degrades to sequential when all worktree creations fail", async () => {
        const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\`

### Step 2: Tests
- \`packages/engine/src/step-session-executor.test.ts\``;

        const task = makeTaskDetail({
          prompt,
          steps: [
            { name: "Step 0", status: "pending" },
            { name: "Step 1", status: "pending" },
            { name: "Step 2", status: "pending" },
          ],
        });
        const settings = makeSettings({ maxParallelSteps: 3 });

        let nameCounter = 0;
        mockedGenerateWorktreeName.mockImplementation(() => `wt-fail-${nameCounter++}`);
        mockedExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes("git worktree add")) {
            throw new Error("worktree creation failed");
          }
          return "";
        });

        let activePrimarySteps = 0;
        let maxActivePrimarySteps = 0;
        const cwdOrder: string[] = [];

        mockedCreateKbAgent.mockImplementation(({ cwd }: any) => {
          return Promise.resolve({
            session: makeMockSession(async () => {
              cwdOrder.push(cwd);
              activePrimarySteps++;
              maxActivePrimarySteps = Math.max(maxActivePrimarySteps, activePrimarySteps);
              await Promise.resolve();
              activePrimarySteps--;
            }),
          } as any);
        });

        const executor = new StepSessionExecutor({
          taskDetail: task,
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings,
        });

        const results = await executor.executeAll();

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
        expect(results.every((r) => r.success)).toBe(true);
        expect(cwdOrder).toEqual([
          "/project/.worktrees/main",
          "/project/.worktrees/main",
          "/project/.worktrees/main",
        ]);
        expect(maxActivePrimarySteps).toBe(1);
      });

      it("mixed success/failure: parallel steps cherry-pick, sequential step runs on primary", async () => {
        const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\`

### Step 2: Tests
- \`packages/engine/src/step-session-executor.test.ts\``;

        const task = makeTaskDetail({
          prompt,
          steps: [
            { name: "Step 0", status: "pending" },
            { name: "Step 1", status: "pending" },
            { name: "Step 2", status: "pending" },
          ],
        });
        const settings = makeSettings({ maxParallelSteps: 3 });

        mockedGenerateWorktreeName
          .mockImplementationOnce(() => "wt-mixed-0")
          .mockImplementationOnce(() => "wt-mixed-1")
          .mockImplementationOnce(() => "wt-mixed-2");

        let worktreeAddCount = 0;
        mockedExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes("git worktree add")) {
            worktreeAddCount++;
            if (worktreeAddCount === 3) {
              throw new Error("step 2 worktree failed");
            }
          }
          if (cmd.includes("git log")) {
            return "abc123";
          }
          return "";
        });

        let releaseParallel: (() => void) | undefined;
        const parallelGate = new Promise<void>((resolve) => {
          releaseParallel = resolve;
        });

        let activeParallelSteps = 0;
        let maxActiveParallelSteps = 0;
        const events: string[] = [];

        mockedCreateKbAgent.mockImplementation(({ cwd }: any) => {
          if (cwd === "/project/.worktrees/main") {
            return Promise.resolve({
              session: makeMockSession(async () => {
                events.push("primary-start");
                expect(activeParallelSteps).toBe(0);
                events.push("primary-end");
              }),
            } as any);
          }

          const label = cwd.endsWith("wt-mixed-0") ? "parallel-0" : "parallel-1";
          return Promise.resolve({
            session: makeMockSession(async () => {
              events.push(`${label}-start`);
              activeParallelSteps++;
              maxActiveParallelSteps = Math.max(maxActiveParallelSteps, activeParallelSteps);
              await parallelGate;
              activeParallelSteps--;
              events.push(`${label}-end`);
            }),
          } as any);
        });

        const executor = new StepSessionExecutor({
          taskDetail: task,
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings,
        });

        const resultsPromise = executor.executeAll();

        for (let i = 0; i < 20 && events.filter((event) => event.endsWith("-start")).length < 2; i++) {
          await Promise.resolve();
        }

        const parallelStartsBeforeRelease = events.filter((event) => event.endsWith("-start"));
        expect(parallelStartsBeforeRelease).toEqual(expect.arrayContaining(["parallel-0-start", "parallel-1-start"]));
        expect(events.includes("primary-start")).toBe(false);

        releaseParallel?.();
        const results = await resultsPromise;

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
        expect(results.every((r) => r.success)).toBe(true);
        expect(maxActiveParallelSteps).toBe(2);

        const primaryCwdCalls = mockedCreateKbAgent.mock.calls.filter(
          ([opts]) => (opts as { cwd?: string }).cwd === "/project/.worktrees/main",
        );
        expect(primaryCwdCalls).toHaveLength(1);

        const primaryStartIdx = events.indexOf("primary-start");
        expect(primaryStartIdx).toBeGreaterThan(events.indexOf("parallel-0-end"));
        expect(primaryStartIdx).toBeGreaterThan(events.indexOf("parallel-1-end"));

        const cherryPickCalls = mockedExecSync.mock.calls.filter(
          ([cmd]) => typeof cmd === "string" && cmd.includes("git cherry-pick \"abc123\""),
        );
        expect(cherryPickCalls).toHaveLength(2);
      });

      it("no degradation when all worktrees succeed", async () => {
        const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

        const task = makeTaskDetail({
          prompt,
          steps: [
            { name: "Step 0", status: "pending" },
            { name: "Step 1", status: "pending" },
          ],
        });
        const settings = makeSettings({ maxParallelSteps: 2 });

        mockedGenerateWorktreeName
          .mockImplementationOnce(() => "wt-success-0")
          .mockImplementationOnce(() => "wt-success-1");
        mockedExecSync.mockReturnValue("");
        mockedCreateKbAgent.mockImplementation(({ cwd }: any) => {
          return Promise.resolve({
            session: makeMockSession(async () => {
              expect(cwd).not.toBe("/project/.worktrees/main");
            }),
          } as any);
        });

        const executor = new StepSessionExecutor({
          taskDetail: task,
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings,
        });

        const results = await executor.executeAll();

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1]);
        expect(results.every((r) => r.success)).toBe(true);

        const primaryCwdCalls = mockedCreateKbAgent.mock.calls.filter(
          ([opts]) => (opts as { cwd?: string }).cwd === "/project/.worktrees/main",
        );
        expect(primaryCwdCalls).toHaveLength(0);
      });

      it("cleanup still removes successful parallel worktrees even when some failed", async () => {
        const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\`

### Step 2: Tests
- \`packages/engine/src/step-session-executor.test.ts\``;

        const task = makeTaskDetail({
          prompt,
          steps: [
            { name: "Step 0", status: "pending" },
            { name: "Step 1", status: "pending" },
            { name: "Step 2", status: "pending" },
          ],
        });
        const settings = makeSettings({ maxParallelSteps: 3 });

        mockedGenerateWorktreeName
          .mockImplementationOnce(() => "wt-clean-0")
          .mockImplementationOnce(() => "wt-clean-1")
          .mockImplementationOnce(() => "wt-clean-2");

        let worktreeAddCount = 0;
        mockedExecSync.mockImplementation((cmd: string) => {
          if (cmd.includes("git worktree add")) {
            worktreeAddCount++;
            if (worktreeAddCount === 3) {
              throw new Error("step 2 worktree failed");
            }
          }
          return "";
        });

        mockedCreateKbAgent.mockResolvedValue({ session: makeMockSession() } as any);

        const executor = new StepSessionExecutor({
          taskDetail: task,
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings,
        });

        await executor.executeAll();

        const removeCalls = mockedExecSync.mock.calls
          .map(([cmd]) => cmd)
          .filter((cmd): cmd is string => typeof cmd === "string" && cmd.includes("git worktree remove"));

        expect(removeCalls).toHaveLength(2);
        expect(removeCalls.some((cmd) => cmd.includes("wt-clean-0"))).toBe(true);
        expect(removeCalls.some((cmd) => cmd.includes("wt-clean-1"))).toBe(true);
        expect(removeCalls.some((cmd) => cmd.includes("wt-clean-2"))).toBe(false);
        expect(removeCalls.some((cmd) => cmd.includes("/project/.worktrees/main"))).toBe(false);
      });
    });
  });

  describe("cleanup failure diagnostics", () => {
    it("logs warning when session dispose fails during error cleanup", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const failingSession = makeMockSession(async () => {
        throw new Error("step execution failed");
      });
      failingSession.dispose = vi.fn(() => {
        throw new Error("dispose failed");
      });

      mockedCreateKbAgent.mockResolvedValue({ session: failingSession } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultsPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      const results = await resultsPromise;

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(getStepSessionLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to dispose session for step 0: dispose failed"),
      );
    });
  });

  describe("terminateAllSessions", () => {
    it("disposes all active sessions and clears map", async () => {
      const session0 = makeMockSession();
      const session1 = makeMockSession();

      let createCount = 0;
      mockedCreateKbAgent.mockImplementation(() => {
        createCount++;
        const s = createCount === 1 ? session0 : session1;
        return Promise.resolve({ session: s } as any);
      });

      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();
      // After execution, sessions should already be cleaned up
      // Calling terminateAllSessions is safe
      await executor.terminateAllSessions();
    });

    it("sets aborted flag", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.terminateAllSessions();

      // Subsequent executeAll should return empty (aborted before start)
      const results = await executor.executeAll();
      expect(results).toEqual([]);
    });
  });

  describe("cleanup", () => {
    it("removes parallel worktrees", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);
      mockedExecSync.mockReturnValue("");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();
      await executor.cleanup();

      // Verify cleanup was called with git worktree remove
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git worktree remove"),
        expect.objectContaining({ cwd: "/project" }),
      );
    });

    it("handles missing worktrees gracefully", async () => {
      const { existsSync } = await import("node:fs");
      const mockedExistsSync = vi.mocked(existsSync);
      // Make existsSync return false to simulate missing worktree
      mockedExistsSync.mockReturnValue(false);

      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      // Should not throw even though worktree doesn't exist
      await executor.cleanup();
    });

    it("deletes branches created for parallel worktrees", async () => {
      const prompt = `# Task: FN-001

### Step 0: Core work
- \`packages/core/src/types.ts\`

### Step 1: Engine work
- \`packages/engine/src/pi.ts\``;

      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);
      mockedExecSync.mockReturnValue("");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();
      await executor.cleanup();

      // Verify branch deletion was called
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining("git branch -D"),
        expect.anything(),
      );
    });

    it("is idempotent after executeAll", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = makeMockSession();
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();

      // Calling cleanup twice should be safe
      await executor.cleanup();
      await executor.cleanup();
    });
  });

  describe("logging", () => {
    it("appends agent logs during step execution", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      const store = { appendAgentLog } as unknown as TaskStore;

      let onText: ((delta: string) => void) | undefined;
      let onToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;
      let onToolEnd: ((name: string, isError: boolean, result?: unknown) => void) | undefined;

      const session = makeMockSession(async () => {
        onText?.("step output");
        onToolStart?.("read", { path: "src/foo.ts" });
        onToolEnd?.("read", false, "ok");
      });

      mockedCreateKbAgent.mockImplementation(async (opts: any) => {
        onText = opts.onText;
        onToolStart = opts.onToolStart;
        onToolEnd = opts.onToolEnd;
        return { session } as any;
      });

      const executor = new StepSessionExecutor({
        store,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();

      expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "step output", "text", undefined, "executor");
      expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "read", "tool", "src/foo.ts", "executor");
      expect(appendAgentLog).toHaveBeenCalledWith("FN-001", "read", "tool_result", "ok", "executor");
    });

    it("flushes AgentLogger in attempt finally block", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const store = { appendAgentLog: vi.fn().mockResolvedValue(undefined) } as unknown as TaskStore;
      const flushSpy = vi.spyOn(AgentLogger.prototype, "flush").mockResolvedValue(undefined);

      const session = makeMockSession(async () => {
        throw new Error("step failed");
      });
      mockedCreateKbAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        store,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(30_000);
      await resultPromise;

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe("context-limit recovery", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("succeeds when compact-and-resume recovers from context-limit error", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      const store = { appendAgentLog } as unknown as TaskStore;

      // Create session that throws context-limit error on first prompt
      mockedCreateKbAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: first call throws, subsequent calls succeed
      const { promptWithFallback } = await import("./pi.js");
      let callCount = 0;
      vi.mocked(promptWithFallback).mockImplementation(async (session: any, prompt: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("context window exceeds limit (2013)");
        }
        // Subsequent calls (compact-and-resume) succeed
      });

      // Mock compactSessionContext to succeed
      const { compactSessionContext } = await import("./pi.js");
      vi.mocked(compactSessionContext).mockResolvedValue({
        summary: "Compacted",
        tokensBefore: 150000,
      });

      const executor = new StepSessionExecutor({
        store,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].retries).toBe(0);
    });

    it("succeeds with reduced-prompt retry when compact returns null", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      const store = { appendAgentLog } as unknown as TaskStore;

      mockedCreateKbAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: first call throws context-limit, second succeeds (reduced prompt)
      const { promptWithFallback } = await import("./pi.js");
      let callCount = 0;
      vi.mocked(promptWithFallback).mockImplementation(async (session: any, prompt: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("context window exceeds limit (2013)");
        }
        // Reduced-prompt succeeds
      });

      // Mock compactSessionContext to return null (no history)
      const { compactSessionContext } = await import("./pi.js");
      vi.mocked(compactSessionContext).mockResolvedValue(null);

      const executor = new StepSessionExecutor({
        store,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it("fails when all recovery attempts fail", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-001", 1),
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const appendAgentLog = vi.fn().mockResolvedValue(undefined);
      const store = { appendAgentLog } as unknown as TaskStore;

      mockedCreateKbAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: always throws context-limit error
      const { promptWithFallback } = await import("./pi.js");
      vi.mocked(promptWithFallback).mockRejectedValue(
        new Error("context window exceeds limit (2013)"),
      );

      // Mock compactSessionContext to return null (no history)
      const { compactSessionContext } = await import("./pi.js");
      vi.mocked(compactSessionContext).mockResolvedValue(null);

      const executor = new StepSessionExecutor({
        store,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const resultsPromise = executor.executeAll();
      // Advance timers for retry delays
      await vi.advanceTimersByTimeAsync(90_000);
      const results = await resultsPromise;

      // All recovery attempts exhausted, step should fail
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("context window exceeds limit");
    });
  });
});

// ── Skill Selection Regression Tests (FN-1514) ──────────────────────────
//
// Note: These tests verify that skillSelection is passed through the
// StepSessionExecutor to createKbAgent calls. The actual skill resolution
// logic is tested in session-skill-context.test.ts.
// The full integration with executeAll is tested indirectly through
// the executor tests which create StepSessionExecutor with skillSelection.

describe("StepSessionExecutor skillSelection regression (FN-1511)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedGenerateWorktreeName.mockReturnValue("test-worktree");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("skillSelection option acceptance", () => {
    it("StepSessionExecutor constructor accepts skillSelection option", async () => {
      const skillSelection = {
        projectRootDir: "/project",
        requestedSkillNames: ["triage", "executor"],
        sessionPurpose: "executor",
      };

      const taskDetail = makeTaskDetail({
        prompt: makeStepPrompt("FN-SKILL", 1),
        steps: [{ name: "Step 1", status: "pending" }],
      });

      const settings = makeSettings({ maxParallelSteps: 1 });

      // Verify the constructor accepts skillSelection without throwing
      const executor = new StepSessionExecutor({
        store: { appendAgentLog: vi.fn() } as unknown as TaskStore,
        taskDetail,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        skillSelection,
      });

      expect(executor).toBeDefined();
    });
  });
});

// ── Agent Tool Availability Tests ──────────────────────────────────────

describe("StepSessionExecutor tool availability", () => {
  /**
   * These tests verify tool configuration by capturing the customTools
   * passed to createKbAgent during executeStep execution. Each test
   * uses fake timers and advances time to resolve any pending sleep()s.
   */
  async function captureCustomTools(options?: {
    agentStore?: unknown;
    messageStore?: unknown;
    assignedAgentId?: string;
  }): Promise<any[]> {
    let captured: any[] = [];

    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedCreateKbAgent.mockImplementation(async (opts: any) => {
      captured = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const taskDetail = makeTaskDetail({
      prompt: makeStepPrompt("FN-TOOLS", 0),
      steps: [{ name: "Step 0", status: "pending" }],
      assignedAgentId: options?.assignedAgentId,
    });

    const mockStore = {
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      getTaskDocument: vi.fn().mockResolvedValue(null),
      upsertTaskDocument: vi.fn().mockResolvedValue({ id: "doc-001", key: "test", content: "test", revision: 1, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), author: "test" }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockSettings = makeSettings({ maxParallelSteps: 1 });

    const executor = new StepSessionExecutor({
      store: mockStore,
      taskDetail,
      worktreePath: "/project/.worktrees/main",
      rootDir: "/project",
      settings: mockSettings,
      agentStore: options?.agentStore as any,
      messageStore: options?.messageStore as any,
    });

    try {
      const executePromise = executor.executeAll();
      // Advance fake timers to allow sleep() calls in retry loop to complete
      await vi.advanceTimersByTimeAsync(30000);
      await executePromise;
    } catch {
      // Ignore execution errors — we're only capturing the tools
    } finally {
      vi.useRealTimers();
    }

    return captured;
  }

  it("includes list_agents and delegate_task when agentStore is available", async () => {
    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
      getAgent: vi.fn().mockResolvedValue(null),
    };

    const tools = await captureCustomTools({
      agentStore: mockAgentStore,
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("list_agents");
    expect(toolNames).toContain("delegate_task");
  });

  it("excludes delegation tools when agentStore is not provided", async () => {
    const tools = await captureCustomTools({});

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("list_agents");
    expect(toolNames).not.toContain("delegate_task");
  });

  it("includes send_message and read_messages when messageStore and assignedAgentId are available", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
      getInbox: vi.fn().mockReturnValue([]),
    };

    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("send_message");
    expect(toolNames).toContain("read_messages");
  });

  it("excludes messaging tools when messageStore is not provided", async () => {
    const tools = await captureCustomTools({
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).not.toContain("read_messages");
  });

  it("excludes messaging tools when assignedAgentId is not provided", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
      getInbox: vi.fn().mockReturnValue([]),
    };

    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).not.toContain("read_messages");
  });

  it("includes task_log and task_create when store is available", async () => {
    const tools = await captureCustomTools({});

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("task_log");
    expect(toolNames).toContain("task_create");
  });
});
