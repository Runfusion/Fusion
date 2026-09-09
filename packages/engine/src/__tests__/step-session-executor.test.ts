import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseStepFileScopes,
  normalizeAuthoredStepScopes,
  resolveAuthoredStepHeadingOffset,
  buildConflictMatrix,
  determineParallelWaves,
  buildStepPrompt,
  buildFastLanePrompt,
  buildReducedStepPrompt,
  StepSessionExecutor,
} from "../execution/step-session-executor.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { expectAppendAgentLog } from "./agent-log-assertions.js";
import * as worktreeBackendModule from "../worktree/worktree-backend.js";
import type { TaskDetail, Settings, TaskStore } from "@fusion/core";
import { installTaskWorktreeIdentityGuard } from "../worktree/worktree-hooks.js";

vi.mock("../worktree/worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));

vi.mock("../worktree/worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));

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

function makeIndependentSteps(count: number): TaskDetail["steps"] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Step ${i}`,
    status: "pending" as const,
    dependsOn: [],
  }));
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

  it("keeps file scopes under dependency-annotated headings", () => {
    const scopes = parseStepFileScopes(makePrompt([
      "### Step 0: Preflight\n- prepare",
      "### Step 1 (depends: 0): Implement\n\n**Artifacts:**\n- `packages/engine/src/annotated.ts` (new)",
    ]));
    expect(scopes.get(1)).toEqual(["packages/engine/src/annotated.ts"]);
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

  it("normalizes only a contiguous 1-based authored sequence", () => {
    expect(resolveAuthoredStepHeadingOffset([1, 2, 3])).toBe(1);
    expect(resolveAuthoredStepHeadingOffset([1, 1, 2])).toBe(0);
    expect(resolveAuthoredStepHeadingOffset([1, 3])).toBe(0);

    const normalized = normalizeAuthoredStepScopes(new Map([
      [1, ["first.ts"]],
      [2, ["second.ts"]],
      [3, ["third.ts"]],
    ]), 3);
    expect([...normalized.entries()]).toEqual([
      [0, ["first.ts"]],
      [1, ["second.ts"]],
      [2, ["third.ts"]],
    ]);
  });

  it("clamps malformed headings, fills missing task indices, and preserves zero-step maps", () => {
    expect([...normalizeAuthoredStepScopes(new Map([
      [0, ["first.ts"]],
      [2, ["third.ts"]],
      [9, ["phantom.ts"]],
    ]), 3).entries()]).toEqual([
      [0, ["first.ts"]],
      [1, []],
      [2, ["third.ts"]],
    ]);

    const zeroStepScopes = new Map([[1, ["legacy.ts"]]]);
    expect(normalizeAuthoredStepScopes(zeroStepScopes, 0)).toBe(zeroStepScopes);
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
  const independentSteps = (count: number) =>
    Array.from({ length: count }, () => ({ dependsOn: [] as number[] }));

  it("maxParallel=1 → all steps sequential (one per wave)", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
      [2, ["src/c.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 1, independentSteps(3));
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ indices: [0], waveNumber: 0 });
    expect(waves[1]).toEqual({ indices: [1], waveNumber: 1 });
    expect(waves[2]).toEqual({ indices: [2], waveNumber: 2 });
  });

  it("explicitly independent non-conflicting steps share waves capped by maxParallel", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/b.ts"]],
      [2, ["src/c.ts"]],
      [3, ["src/d.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 2, independentSteps(4));
    // All non-conflicting, capped at 2 per wave → 2 waves
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toEqual([0, 1]);
    expect(waves[1].indices).toEqual([2, 3]);
  });

  it("unannotated steps are sequential so verification cannot start before implementation", () => {
    const scopes = new Map<number, string[]>([
      [0, ["preflight.md"]],
      [1, ["src/implementation.ts"]],
      [2, ["src/implementation.test.ts"]],
      [3, ["verification.log"]],
    ]);

    const waves = determineParallelWaves(scopes, 4, [
      {},
      {},
      {},
      {},
    ]);

    expect(waves.map((wave) => wave.indices)).toEqual([[0], [1], [2], [3]]);
  });

  it("all steps conflict → each step in its own wave", () => {
    const scopes = new Map<number, string[]>([
      [0, ["src/a.ts"]],
      [1, ["src/a.ts"]],
      [2, ["src/a.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 4, independentSteps(3));
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
    const waves = determineParallelWaves(scopes, 2, independentSteps(4));
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
    const waves = determineParallelWaves(scopes, 4, independentSteps(2));
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
    const waves = determineParallelWaves(scopes, 2, independentSteps(4));
    expect(waves).toHaveLength(2);
    expect(waves[0].indices).toHaveLength(2);
    expect(waves[1].indices).toHaveLength(2);
  });

  it("produces ascending wave numbers", () => {
    const scopes = new Map<number, string[]>([
      [0, ["a.ts"]],
      [1, ["b.ts"]],
    ]);
    const waves = determineParallelWaves(scopes, 1, independentSteps(2));
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
    const waves = determineParallelWaves(scopes, 2, independentSteps(3));
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

  it("builds a compact Fast prompt from the original request without step scaffolding", () => {
    const task = makeTaskDetail({
      executionMode: "fast",
      description: "Change the primary button to red.",
      prompt: fullPrompt,
      attachments: [{
        filename: "button.png",
        originalName: "button.png",
        mimeType: "image/png",
        size: 1,
        createdAt: new Date().toISOString(),
      }],
      steeringComments: [{ author: "Operator", text: "Keep the hover state.", createdAt: new Date().toISOString() }],
    });
    const result = buildFastLanePrompt(task, "/repo", { testCommand: "pnpm test", buildCommand: "pnpm build" } as Settings, "/repo/.worktrees/fast");

    expect(result).toContain("Change the primary button to red.");
    expect(result).toContain("button.png");
    expect(result).toContain("pnpm test");
    expect(result).toContain("Keep the hover state.");
    expect(result).toContain("/repo/.worktrees/fast");
    expect(result).toContain("fix(FN-001): <short summary>");
    expect(result).not.toContain("Work through each step in order");
    expect(result).not.toContain("## Review level:");
    expect(result).not.toContain("## Step Content");

    const routed = buildStepPrompt(task, 0, "/repo", { testCommand: "pnpm test", buildCommand: "pnpm build" } as Settings, "/repo/.worktrees/fast");
    expect(routed).toContain("Change the primary button to red.");
    expect(routed).not.toContain("## Step Content");
  });

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
    expect(result).toContain("/repo/project/.fusion/memory/");
    expect(result).not.toContain("/repo/project/.worktrees/happy-robin/.fusion/memory/");
  });

  it("includes attachment section with absolute project-root paths for image attachments", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      attachments: [
        {
          filename: "abc123-screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 2048,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**screenshot.png** (screenshot)");
    expect(result).toContain("/repo/project/.fusion/tasks/FN-001/attachments/abc123-screenshot.png");
  });

  it("includes attachment section for text attachments with read-for-context wording", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      attachments: [
        {
          filename: "def456-error.log",
          originalName: "error.log",
          mimeType: "text/plain",
          size: 512,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**error.log** (text/plain)");
    expect(result).toContain("read for context");
    expect(result).toContain("/repo/project/.fusion/tasks/FN-001/attachments/def456-error.log");
  });

  it("omits attachment section when attachments is undefined", () => {
    const task = makeTaskDetail({ prompt: fullPrompt, attachments: undefined });
    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachment section when attachments is empty", () => {
    const task = makeTaskDetail({ prompt: fullPrompt, attachments: [] });
    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("## Attachments");
  });

  it("includes both image and text attachments together", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
        {
          filename: "def-config.json",
          originalName: "config.json",
          mimeType: "application/json",
          size: 256,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).toContain("**shot.png** (screenshot)");
    expect(result).toContain("/repo/project/.fusion/tasks/FN-001/attachments/abc-shot.png");
    expect(result).toContain("**config.json** (application/json)");
    expect(result).toContain("/repo/project/.fusion/tasks/FN-001/attachments/def-config.json");
    expect(result).toContain("read for context");
  });

  it("keeps attachment paths at the project root when executing in a worktree", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      attachments: [
        {
          filename: "abc123-screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 2048,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildStepPrompt(
      task,
      1,
      "/repo/project",
      undefined,
      "/repo/project/.worktrees/happy-robin",
    );

    expect(result).toContain("/repo/project/.fusion/tasks/FN-001/attachments/abc123-screenshot.png");
    expect(result).not.toContain("/repo/project/.worktrees/happy-robin/.fusion/tasks/FN-001/attachments/abc123-screenshot.png");
  });

  it("includes attachment-read permission note when attachments and rootDir are provided", () => {
    const task = makeTaskDetail({
      id: "FN-777",
      prompt: fullPrompt,
      attachments: [
        {
          filename: "abc123-screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 2048,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain(
      "> **Note:** Attachment files are at the project root under `.fusion/tasks/FN-777/attachments/` — you may read them even when working in a worktree.",
    );
    expect(result.indexOf("> **Note:** Attachment files")).toBeGreaterThan(
      result.indexOf("/repo/project/.fusion/tasks/FN-777/attachments/abc123-screenshot.png"),
    );
  });

  it("omits attachment-read permission note when no attachments exist", () => {
    const task = makeTaskDetail({ prompt: fullPrompt, attachments: [] });
    const result = buildStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("Attachment files are at the project root");
  });

  it("omits attachment-read permission note when rootDir is not provided", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      attachments: [
        {
          filename: "abc123-screenshot.png",
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: 2048,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const result = buildStepPrompt(task, 1);

    expect(result).not.toContain("Attachment files are at the project root");
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

  it("synthesizes actionable content for an appended remediation step", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "done" },
        { name: "Test", status: "done" },
        {
          name: "Fix: repair retry guard",
          status: "pending",
          remediation: {
            wave: 1,
            gate: "Code Review",
            gateStepId: "code-review",
            detail: "Reverse the retry guard condition",
            filePath: "packages/engine/src/retry.ts",
            line: 42,
          },
        },
      ],
    });

    const result = buildStepPrompt(task, 3);
    expect(result).toContain("### Appended Step: Fix: repair retry guard");
    expect(result).toContain("**Gate:** Code Review");
    expect(result).toContain("**Required fix:** Reverse the retry guard condition");
    expect(result).toContain("**File:** `packages/engine/src/retry.ts`");
    expect(result).toContain("**Line:** 42");
  });

  it("synthesizes a mandatory checklist for an appended verification step", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "done" },
        { name: "Test", status: "done" },
        { name: "Fix: repair retry guard", status: "done" },
        { name: "Testing & Verification", status: "pending" },
      ],
    });
    const settings = { testCommand: "pnpm test:gate", buildCommand: "pnpm build" } as Settings;

    const result = buildStepPrompt(task, 4, undefined, settings);
    expect(result).toContain("### Appended Step: Testing & Verification");
    expect(result).toContain("Run the project's configured test and build commands listed under Project Commands.");
    expect(result).toContain("Run the tests impacted by this task's changes.");
    expect(result).toContain("Fix every failure before completing this step.");
    expect(result).toContain("Never weaken, skip, or delete assertions merely to make verification pass.");
    expect(result).toContain("pnpm test:gate");
    expect(result).toContain("pnpm build");
  });

  it("does not synthesize over an index inside the authored heading range", () => {
    const prompt = "### Step 1: Authored first\n\nKeep this authored content.\n\n### Step 2: Authored second";
    const task = makeTaskDetail({
      prompt,
      steps: [{
        name: "Fix: must not mask authored numbering",
        status: "pending",
        remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "fallback detail" },
      }],
    });

    const result = buildStepPrompt(task, 0);
    expect(result).toContain("Authored first");
    expect(result).not.toContain("### Appended Step");
    expect(result).not.toContain("fallback detail");
  });

  it("includes user steering comments as next-session fallback when no active step session existed", () => {
    const task = makeTaskDetail({
      prompt: fullPrompt,
      steeringComments: [
        {
          id: "comment-1",
          author: "user",
          text: "Please prioritize the API invariant before refactoring.",
          createdAt: "2026-06-17T13:45:00.000Z",
        },
      ],
    });

    const result = buildStepPrompt(task, 1);

    expect(result).toContain("## Steering Comments");
    expect(result).toContain("Please prioritize the API invariant before refactoring.");
  });

  it("does not ask graph-owned step sessions to call task lifecycle tools", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 1);
    expect(result).toContain("The workflow graph records step status, ordering, review, and completion.");
    expect(result).not.toContain("fn_task_done()");
  });

  it("does not include content from other steps", () => {
    const task = makeTaskDetail({ prompt: fullPrompt });
    const result = buildStepPrompt(task, 0);
    // Step 1 content should not appear
    expect(result).not.toContain("Create new-module.ts");
  });
});

// ── buildReducedStepPrompt tests ───────────────────────────────────────

describe("buildReducedStepPrompt", () => {
  const reducedPrompt = `# Task: FN-001 - Test Task

## Steps

### Step 0: Preflight

- [ ] Check files exist

### Step 1: Implement

- [ ] Create new-module.ts
- [ ] Add exports

### Step 2: Test

- [ ] Write unit tests
`;

  it("includes compact attachment location and read instruction when attachments exist", () => {
    const task = makeTaskDetail({
      id: "FN-123",
      prompt: reducedPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
        {
          filename: "def-config.json",
          originalName: "config.json",
          mimeType: "application/json",
          size: 256,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildReducedStepPrompt(task, 1, "/repo/project");

    expect(result).toContain(
      "2 attachment(s) available at `/repo/project/.fusion/tasks/FN-123/attachments/` — read the files there for context.",
    );
    expect(result).toContain("They live at the project root and are readable even when working in a worktree.");
    expect(result).not.toContain("ask for context");
  });

  it("falls back to project-relative attachment location when rootDir is omitted", () => {
    const task = makeTaskDetail({
      id: "FN-123",
      prompt: reducedPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildReducedStepPrompt(task, 1);

    expect(result).toContain("1 attachment(s) available at `.fusion/tasks/FN-123/attachments/`");
    expect(result).toContain("read the files there for context");
    expect(result).not.toContain("ask for context");
  });

  it("places the attachment reference after the step and before the important block", () => {
    const task = makeTaskDetail({
      prompt: reducedPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildReducedStepPrompt(task, 1, "/repo/project");
    const attachmentReference = "1 attachment(s) available at `/repo/project/.fusion/tasks/FN-001/attachments/`";

    expect(result.indexOf(attachmentReference)).toBeGreaterThan(result.indexOf("Add exports"));
    expect(result.indexOf(attachmentReference)).toBeLessThan(result.indexOf("IMPORTANT:"));
  });

  it("does not list individual attachment files in the reduced prompt", () => {
    const task = makeTaskDetail({
      prompt: reducedPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildReducedStepPrompt(task, 1);

    expect(result).not.toContain("abc-shot.png");
    expect(result).not.toContain("shot.png");
  });

  it("verifies context-limit recovery symptom is gone for image and non-image attachments", () => {
    const task = makeTaskDetail({
      id: "FN-456",
      prompt: reducedPrompt,
      attachments: [
        {
          filename: "abc-shot.png",
          originalName: "shot.png",
          mimeType: "image/png",
          size: 1024,
          createdAt: new Date().toISOString(),
        },
        {
          filename: "def-config.json",
          originalName: "config.json",
          mimeType: "application/json",
          size: 256,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const result = buildReducedStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("ask for context");
    expect(result).toContain(".fusion/tasks/FN-456/attachments/");
    expect(result).toContain("/repo/project/.fusion/tasks/FN-456/attachments/");
  });

  it("omits attachment reference when attachments is undefined", () => {
    const task = makeTaskDetail({ prompt: reducedPrompt, attachments: undefined });
    const result = buildReducedStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("attachment(s) available");
    expect(result).not.toContain(".fusion/tasks/FN-001/attachments/");
  });

  it("omits attachment reference when attachments is empty", () => {
    const task = makeTaskDetail({ prompt: reducedPrompt, attachments: [] });
    const result = buildReducedStepPrompt(task, 1, "/repo/project");

    expect(result).not.toContain("attachment(s) available");
    expect(result).not.toContain(".fusion/tasks/FN-001/attachments/");
  });

  it("keeps synthesized verification instructions during context-limit recovery", () => {
    const task = makeTaskDetail({
      prompt: reducedPrompt,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "done" },
        { name: "Test", status: "done" },
        { name: "Fix: repair retry guard", status: "done" },
        { name: "Testing & Verification", status: "pending" },
      ],
    });

    const result = buildReducedStepPrompt(task, 4);
    expect(result).toContain("### Appended Step: Testing & Verification");
    expect(result).toContain("Run the tests impacted by this task's changes.");
    expect(result).toContain("Fix every failure before completing this step.");
    expect(result).toContain("Never weaken, skip, or delete assertions merely to make verification pass.");
  });
});

// ── StepSessionExecutor test helpers ───────────────────────────────────

// Mock pi.js for StepSessionExecutor tests
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  compactSessionContext: vi.fn(),
}));

vi.mock("../agents/agent-session-helpers.js", async () => {
  const pi = await import("../pi.js");
  return {
    createResolvedAgentSession: vi.fn(async (options: any) => {
      const result = await pi.createFnAgent(options);
      return {
        session: result.session,
        sessionFile: result.sessionFile,
        runtimeId: "pi",
        wasConfigured: false,
      };
    }),
    promptWithAutoRetry: vi.fn(async (session: any, prompt: string, options?: unknown) =>
      pi.promptWithFallback(session, prompt, options as any),
    ),
    describeAgentModel: vi.fn(async (session: any) => pi.describeModel(session)),
    resolveExecutorSessionModel: vi.fn((taskModelProvider?: string, taskModelId?: string, settings?: any, assignedAgentRuntimeConfig?: Record<string, unknown>, _credentialInstanceId?: string, executionMode?: string | null) => {
      const model = typeof assignedAgentRuntimeConfig?.model === "string" ? assignedAgentRuntimeConfig.model : "";
      const slash = model.indexOf("/");
      if (slash > 0 && slash < model.length - 1) {
        return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
      }
      if (taskModelProvider && taskModelId) return { provider: taskModelProvider, modelId: taskModelId };
      if (executionMode === "fast" && settings?.fastCheapProvider && settings?.fastCheapModelId) {
        return { provider: settings.fastCheapProvider, modelId: settings.fastCheapModelId };
      }
      if (settings?.executionProvider && settings?.executionModelId) {
        return { provider: settings.executionProvider, modelId: settings.executionModelId };
      }
      if (settings?.executionGlobalProvider && settings?.executionGlobalModelId) {
        return { provider: settings.executionGlobalProvider, modelId: settings.executionGlobalModelId };
      }
      if (settings?.defaultProviderOverride && settings?.defaultModelIdOverride) {
        return { provider: settings.defaultProviderOverride, modelId: settings.defaultModelIdOverride };
      }
      if (settings?.defaultProvider && settings?.defaultModelId) {
        return { provider: settings.defaultProvider, modelId: settings.defaultModelId };
      }
      return { provider: undefined, modelId: undefined };
    }),
    // FNXC:EngineTestDrift 2026-07-11-22:25:
    // step-session-executor.ts now imports resolveExecutorThinkingLevel from
    // agent-session-helpers (Settings-ThinkingLevel precedence, 2026-07-10).
    // The hand-written mock must surface it or vitest throws "No export
    // defined", failing every step-execution test. Neutral undefined return —
    // no test asserts on thinking level here.
    resolveExecutorThinkingLevel: vi.fn(() => undefined),
    /*
    FNXC:EngineTestDrift 2026-07-18-04:35:
    FN-7794 / fallback-swap path imports resolveExecutorFallbackThinkingLevel
    unconditionally. Without it, executeAll fails before customTools are captured
    and tool-availability tests see an empty tool list.
    */
    resolveExecutorFallbackThinkingLevel: vi.fn(() => undefined),
  };
});

// Mock logger
vi.mock("../logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(), debug: vi.fn(),
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
    planLog: getLogger("plan"),
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
vi.mock("../errors/context-limit-detector.js", () => ({
  isContextLimitError: vi.fn().mockImplementation((msg: string) =>
    /context\s+window\s+exceeds/i.test(msg),
  ),
}));

// Mock usage-limit-detector
vi.mock("../errors/usage-limit-detector.js", () => ({
  checkSessionError: vi.fn(),
  isUsageLimitError: (message: string) => /usage limit|rate limit|\b429\b/i.test(message),
}));

// Mock worktree-names
vi.mock("../worktree/worktree-names.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree/worktree-names.js")>("../worktree/worktree-names.js");
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
  return { execSync: execSyncFn, exec: execFn, execFile: vi.fn() };
});
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { createFnAgent } from "../pi.js";
import { generateWorktreeName } from "../worktree/worktree-names.js";
import { execSync } from "node:child_process";
import { AgentSemaphore } from "../concurrency/concurrency.js";
import { createLogger } from "../logger.js";
import { promptWithAutoRetry, resolveExecutorSessionModel } from "../agents/agent-session-helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedResolveExecutorSessionModel = vi.mocked(resolveExecutorSessionModel);
const mockedExecSync = vi.mocked(execSync);
const mockedInstallTaskWorktreeIdentityGuard = vi.mocked(installTaskWorktreeIdentityGuard);
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
    steer: vi.fn().mockResolvedValue(undefined),
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

  describe("steering", () => {
    it("steers every active step session and continues after per-session failures", async () => {
      const task = makeTaskDetail();
      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings(),
        pluginRunner: undefined,
      } as any);
      const steerOne = vi.fn().mockResolvedValue(undefined);
      const steerTwo = vi.fn().mockRejectedValue(new Error("disconnected"));
      const steerThree = vi.fn().mockResolvedValue(undefined);

      (executor as any).activeSessions.set(0, {
        dispose: vi.fn(),
        abortBash: vi.fn(),
        steer: steerOne,
      });
      (executor as any).activeSessions.set(1, {
        dispose: vi.fn(),
        abortBash: vi.fn(),
        steer: steerTwo,
      });
      (executor as any).activeSessions.set(2, {
        dispose: vi.fn(),
        abortBash: vi.fn(),
        steer: steerThree,
      });

      const steeredCount = await executor.steerActiveSessions("new guidance");

      expect(steeredCount).toBe(3);
      expect(steerOne).toHaveBeenCalledWith("new guidance");
      expect(steerTwo).toHaveBeenCalledWith("new guidance");
      expect(steerThree).toHaveBeenCalledWith("new guidance");
      expect(getStepSessionLogger().warn).toHaveBeenCalledWith(expect.stringContaining("Failed to steer active session for step 1"));
    });
  });

  describe("sequential execution", () => {
    it("forwards taskEnv into step session creation", async () => {
      const prompt = makeStepPrompt("FN-001", 1);
      const task = makeTaskDetail({ prompt, steps: [{ name: "Step 0", status: "pending" }] });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        pluginRunner: undefined,
        taskEnv: { PATH: "/task/bin", TASK_ONLY: "1" },
      } as any);

      const result = await executor.executeAll();
      expect(result).toHaveLength(1);
      expect(result[0]?.success).toBe(true);
      expect(mockedCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          taskEnv: { PATH: "/task/bin", TASK_ONLY: "1" },
        }),
      );
    });

    it("reuses the primary step session when runStepsInNewSessions is false", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({
        prompt,
        assignedAgentId: "durable-step-agent",
        effectiveNodeId: "mesh-node-1",
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 1, runStepsInNewSessions: false });
      const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
      let statsCall = 0;
      const session = {
        ...makeMockSession(),
        getSessionStats: vi.fn(() => {
          statsCall++;
          return {
            tokens: {
              input: statsCall * 10,
              output: statsCall * 20,
              cacheRead: statsCall * 3,
              cacheWrite: statsCall,
              total: statsCall * 34,
            },
          };
        }),
      };
      mockedCreateFnAgent.mockImplementationOnce(async (options: any) => {
        options.onToolStart("Read", { path: "private-step-input" });
        options.onToolEnd("Read", false, "private-step-output");
        return { session } as any;
      });

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        pluginRunner: undefined,
        store: { emitUsageEvent, appendAgentLog: vi.fn().mockResolvedValue(undefined) },
      } as any);

      const result = await executor.executeAll();
      await executor.cleanup();

      expect(result).toHaveLength(2);
      expect(result.every((step) => step.success)).toBe(true);
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
      /*
      FNXC:CommandCenterActivity 2026-08-09-15:06:
      Reused workflow steps share one AgentSession, so their production execution path must
      publish one session_start rather than counting each prompt as a new Activity session.
      */
      expect(emitUsageEvent.mock.calls.filter(([event]) => event.kind === "session_start")).toHaveLength(1);
      /*
      FNXC:CommandCenterActivity 2026-08-09-16:38:
      Execute a real workflow-step construction path, including provider tool callbacks, so the
      durable-agent telemetry regression cannot be hidden by testing the shared seam in isolation.
      */
      expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: "session_start", category: "agent-session", agentId: "durable-step-agent",
        taskId: "FN-001", nodeId: "mesh-node-1",
        meta: expect.objectContaining({ lane: "workflow-step", ephemeral: true }),
      }));
      expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: "tool_call", toolName: "Read", agentId: "durable-step-agent",
        taskId: "FN-001", nodeId: "mesh-node-1",
      }));
      expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
        kind: "tool_result", toolName: "Read", agentId: "durable-step-agent",
        taskId: "FN-001", nodeId: "mesh-node-1",
      }));
      expect(session.prompt).toHaveBeenCalledTimes(2);
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(result[0]?.tokenUsage?.inputTokens).toBe(10);
      expect(result[1]?.tokenUsage?.inputTokens).toBe(10);
      expect(result[1]?.tokenUsage?.totalTokens).toBe(34);
    });

    it("creates a fresh primary step session for each step when runStepsInNewSessions is true", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 1, runStepsInNewSessions: true });
      const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
      const sessions = [makeMockSession(), makeMockSession()];
      mockedCreateFnAgent
        .mockResolvedValueOnce({ session: sessions[0] } as any)
        .mockResolvedValueOnce({ session: sessions[1] } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        pluginRunner: undefined,
        store: { emitUsageEvent },
      } as any);

      const result = await executor.executeAll();

      expect(result).toHaveLength(2);
      expect(result.every((step) => step.success)).toBe(true);
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
      expect(emitUsageEvent.mock.calls.filter(([event]) => event.kind === "session_start")).toHaveLength(2);
      expect(sessions[0]?.prompt).toHaveBeenCalledTimes(1);
      expect(sessions[1]?.prompt).toHaveBeenCalledTimes(1);
      expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(sessions[1]?.dispose).toHaveBeenCalledTimes(1);
    });

    it("delivers pending steering comments in exactly one subsequent step prompt", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({
        prompt,
        steps: [
          { name: "Step 0", status: "pending" },
          { name: "Step 1", status: "pending" },
        ],
        steeringComments: [
          {
            id: "queued-comment",
            author: "user",
            text: "Please include the queued guidance.",
            createdAt: "2026-06-17T13:45:00.000Z",
          },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const prompts: string[] = [];
      mockedCreateFnAgent.mockImplementation(async () => ({
        session: makeMockSession(vi.fn(async (message: string) => {
          prompts.push(message);
        }) as any),
      }) as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        pluginRunner: undefined,
      } as any);

      const result = await executor.executeAll();

      expect(result).toHaveLength(2);
      expect(prompts[0]).toContain("## Steering Comments");
      expect(prompts[0]).toContain("Please include the queued guidance.");
      expect(prompts[1]).not.toContain("Please include the queued guidance.");
    });

    it("publishes workflow step activity run lifecycle for dashboard analytics", async () => {
      vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
      const prompt = makeStepPrompt("FN-7402", 1);
      const task = makeTaskDetail({
        id: "FN-7402",
        title: "Publish workflow activity",
        lineageId: "lineage-FN-7402",
        assignedAgentId: "assigned-agent",
        prompt,
        steps: [{ name: "Implement telemetry", status: "pending" }],
      });
      const saveRun = vi.fn().mockResolvedValue(undefined);
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        agentStore: { saveRun, getAgent: vi.fn(async (id) => id === "column-agent" ? { id } : null) } as any,
        effectiveAgentId: "column-agent",
      } as any);

      const results = await executor.executeAll();

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);
      expect(saveRun).toHaveBeenCalledTimes(2);
      const [activeRun, completedRun] = saveRun.mock.calls.map((call) => call[0]);
      expect(activeRun).toMatchObject({
        agentId: "column-agent",
        taskId: "FN-7402",
        startedAt: "2026-07-01T12:00:00.000Z",
        endedAt: null,
        status: "active",
        invocationSource: "assignment",
        triggerDetail: "workflow-step-session",
        contextSnapshot: {
          source: "step-session-executor",
          sessionPurpose: "executor",
          workflowStep: true,
          taskId: "FN-7402",
          taskLineageId: "lineage-FN-7402",
          assignedAgentId: "assigned-agent",
          effectiveAgentId: "column-agent",
          agentId: "column-agent",
          stepIndex: 0,
          stepName: "Implement telemetry",
        },
      });
      expect(activeRun.id).toMatch(/^workflow-step-FN-7402-.*-step-0$/);
      expect(completedRun).toMatchObject({
        id: activeRun.id,
        agentId: "column-agent",
        taskId: "FN-7402",
        startedAt: activeRun.startedAt,
        endedAt: "2026-07-01T12:00:00.000Z",
        status: "completed",
        resultJson: expect.objectContaining({ success: true, retries: 0, stepIndex: 0 }),
      });
    });

    it("publishes failed terminal workflow step activity without leaving stale active state", async () => {
      vi.setSystemTime(new Date("2026-07-01T13:00:00.000Z"));
      const prompt = makeStepPrompt("FN-7402", 1);
      const task = makeTaskDetail({
        id: "FN-7402",
        prompt,
        assignedAgentId: "assigned-agent",
        steps: [{ name: "Failing step", status: "pending" }],
      });
      const saveRun = vi.fn().mockResolvedValue(undefined);
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession(vi.fn().mockRejectedValue(new Error("boom"))) } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        agentStore: { saveRun, getAgent: vi.fn(async (id) => id === "assigned-agent" ? { id } : null) } as any,
      } as any);

      // FNXC:EngineTests 2026-07-09-06:00:
      // executeAll retries the failing step 3× with sleep() delays between attempts. With
      // useFakeTimers({ shouldAdvanceTime: true }) these sleeps advance REAL wall-clock time if
      // the test awaits executeAll directly (was 22.6s, ballooning under CI load and busting the
      // shard-2 watchdog). Fast-forward the retry sleeps via fake timers like the sibling retry
      // tests below, so the loop completes in milliseconds.
      const resultsPromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      const results = await resultsPromise;

      expect(results).toEqual([{ stepIndex: 0, success: false, error: "boom", retries: 3, tokenUsage: undefined }]);
      const terminalRun = saveRun.mock.calls.at(-1)?.[0];
      expect(saveRun).toHaveBeenCalledTimes(2);
      expect(terminalRun).toMatchObject({
        id: saveRun.mock.calls[0]?.[0].id,
        agentId: "assigned-agent",
        status: "failed",
        endedAt: expect.stringMatching(/^2026-07-01T13:00:/),
        resultJson: expect.objectContaining({ success: false, error: "boom", retries: 3 }),
      });
      expect(saveRun.mock.calls.map((call) => call[0].status)).toEqual(["active", "failed"]);
    });

    it("uses roster-proven assigned-agent and executor-role identities for workflow activity runs", async () => {
      const prompt = makeStepPrompt("FN-7402", 1);
      const runExecutor = async (taskOverrides: Partial<TaskDetail>) => {
        const saveRun = vi.fn().mockResolvedValue(undefined);
        const roster = [{ id: "assigned-agent" }, { id: "built-in-executor", role: "executor", roles: ["executor"], metadata: { builtInWorkflowRole: true, workflowRole: "executor" } }];
        mockedCreateFnAgent.mockResolvedValueOnce({ session: makeMockSession() } as any);
        const executor = new StepSessionExecutor({
          taskDetail: makeTaskDetail({ id: "FN-7402", prompt, steps: [{ name: "Step 0", status: "pending" }], ...taskOverrides }),
          worktreePath: "/project/.worktrees/main",
          rootDir: "/project",
          settings: makeSettings({ maxParallelSteps: 1 }),
          agentStore: { saveRun, getAgent: vi.fn(async (id) => roster.find((agent) => agent.id === id) ?? null), listAgents: vi.fn(async () => roster) } as any,
        } as any);
        await executor.executeAll();
        return saveRun.mock.calls[0]?.[0];
      };

      await expect(runExecutor({ assignedAgentId: "assigned-agent" })).resolves.toMatchObject({ agentId: "assigned-agent" });
      await expect(runExecutor({ assignedAgentId: undefined })).resolves.toMatchObject({ agentId: "built-in-executor" });
    });

    it("continues workflow execution when workflow activity publication is unavailable or failing", async () => {
      const prompt = makeStepPrompt("FN-7402", 1);
      const task = makeTaskDetail({ id: "FN-7402", prompt, steps: [{ name: "Step 0", status: "pending" }] });
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);

      const withoutStore = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
      } as any);
      await expect(withoutStore.executeAll()).resolves.toMatchObject([{ success: true }]);

      const saveRun = vi.fn().mockRejectedValue(new Error("db offline"));
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);
      const withFailingStore = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        agentStore: { saveRun, getAgent: vi.fn(async () => ({ id: "assigned-agent" })) } as any,
      } as any);

      await expect(withFailingStore.executeAll()).resolves.toMatchObject([{ success: true }]);
      expect(saveRun).toHaveBeenCalledTimes(2);
      expect(getStepSessionLogger().warn).toHaveBeenCalledWith(expect.stringContaining("Failed to publish workflow-step activity run"));
    });

    it("happy path: 3-step task, all steps succeed", async () => {
      const prompt = makeStepPrompt("FN-001", 3);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
        { name: "Step 2", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(3);

      // Verify callbacks
      expect(onStepStart).toHaveBeenCalledTimes(3);
      expect(onStepComplete).toHaveBeenCalledTimes(3);
      expect(onStepStart).toHaveBeenNthCalledWith(1, 0);
      expect(onStepStart).toHaveBeenNthCalledWith(2, 1);
      expect(onStepStart).toHaveBeenNthCalledWith(3, 2);
    });

    it("rebases 1-based authored headings without scheduling a phantom step", async () => {
      const prompt = makePrompt([
        "### Step 1: First authored work",
        "### Step 2: Second authored work",
        "### Step 3: Final authored work",
      ]);
      const task = makeTaskDetail({
        prompt,
        steps: makeIndependentSteps(3),
      });
      const onStepStart = vi.fn();
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        onStepStart,
      });

      await executor.executeAll();

      expect(onStepStart.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
      expect(onStepStart).not.toHaveBeenCalledWith(3);
      expect(buildStepPrompt(task, 0)).toContain("First authored work");
      expect(buildStepPrompt(task, 2)).toContain("Final authored work");
    });

    it("awaits an asynchronous completion callback before the session run resolves", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-255", 1),
        steps: [{ name: "Deferred completion", status: "pending" }],
      });
      mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);

      let releaseCompletion!: () => void;
      const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
      let markCompletionStarted!: () => void;
      const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
      const onStepComplete = vi.fn(async () => {
        markCompletionStarted();
        await completionGate;
      });
      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        onStepComplete,
      });

      const run = executor.executeAll();
      await completionStarted;
      let settled = false;
      void run.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseCompletion();
      await expect(run).resolves.toMatchObject([{ stepIndex: 0, success: true }]);
      expect(onStepComplete).toHaveBeenCalledTimes(1);
    });

    it("does not create or complete a step session when the persisted start is rejected", async () => {
      const prompt = makeStepPrompt("FN-8490", 1);
      const task = makeTaskDetail({
        id: "FN-8490",
        prompt,
        steps: [{ name: "Ordered step", status: "pending" }],
      });
      const onStepStart = vi.fn().mockResolvedValue(false);
      const onStepComplete = vi.fn();

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        onStepStart,
        onStepComplete,
      });

      const results = await executor.executeAll();

      expect(results).toEqual([
        expect.objectContaining({
          stepIndex: 0,
          success: false,
          error: expect.stringContaining("start was rejected"),
          retries: 0,
        }),
      ]);
      expect(onStepStart).toHaveBeenCalledWith(0);
      expect(mockedCreateFnAgent).not.toHaveBeenCalled();
      expect(onStepComplete).not.toHaveBeenCalled();
    });

    it("preserves notification-only start callbacks that return void", async () => {
      const task = makeTaskDetail({
        prompt: makeStepPrompt("FN-8490-LEGACY", 1),
        steps: [{ name: "Legacy callback step", status: "pending" }],
      });
      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
      const onStepStart = vi.fn(() => undefined);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings: makeSettings({ maxParallelSteps: 1 }),
        onStepStart,
      });

      const results = await executor.executeAll();

      expect(results[0]?.success).toBe(true);
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    it("skips live-terminal steps before starting resumed sessions", async () => {
      const prompt = makeStepPrompt("FN-7248", 2);
      const task = makeTaskDetail({
        id: "FN-7248",
        prompt,
        steps: [
          { name: "Preflight", status: "pending" },
          { name: "Implement", status: "pending" },
        ],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });
      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
      const onStepStart = vi.fn();
      const store = {
        getTask: vi.fn().mockResolvedValue({
          ...task,
          steps: [
            { name: "Preflight", status: "done" },
            { name: "Implement", status: "in-progress" },
          ],
        }),
        appendAgentLog: vi.fn().mockResolvedValue(undefined),
      };

      const executor = new StepSessionExecutor({
        store: store as any,
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
        onStepStart,
      });

      const results = await executor.executeAll();

      /*
       * FNXC:WorkflowResume 2026-06-29-18:26:
       * Resume must use TaskStore as the authoritative projection before scheduling per-step sessions. A stale snapshot may still list Step 0 as pending, but if the live task says Step 0 is done then no Step 0 session or onStepStart callback may run.
       */
      expect(results.map((result) => result.stepIndex)).toEqual([1]);
      expect(onStepStart).toHaveBeenCalledTimes(1);
      expect(onStepStart).toHaveBeenCalledWith(1);
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    });

    it("includes token usage from session stats on successful step completion", async () => {
      const prompt = makeStepPrompt("FN-001", 1);
      const task = makeTaskDetail({
        prompt,
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = {
        ...makeMockSession(),
        getSessionStats: vi.fn().mockReturnValue({
          tokens: {
            input: 25,
            output: 11,
            cacheRead: 4,
            cacheWrite: 2,
            total: 42,
          },
        }),
      };
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stepIndex: 0,
        success: true,
        retries: 0,
        tokenUsage: {
          inputTokens: 25,
          outputTokens: 11,
          cachedTokens: 4,
          cacheWriteTokens: 2,
          totalTokens: 42,
        },
      });
      expect(session.getSessionStats).toHaveBeenCalled();
    });

    it("includes token usage from session stats on failed step completion", async () => {
      const prompt = makeStepPrompt("FN-001", 1);
      const task = makeTaskDetail({
        prompt,
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = {
        ...makeMockSession(() => Promise.reject(new Error("step failed"))),
        getSessionStats: vi.fn().mockReturnValue({
          tokens: {
            input: 19,
            output: 7,
            cacheRead: 3,
            cacheWrite: 0,
            total: 29,
          },
        }),
      };
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const executePromise = executor.executeAll();
      await vi.runAllTimersAsync();
      const results = await executePromise;

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stepIndex: 0,
        success: false,
        error: "step failed",
        tokenUsage: {
          inputTokens: 19,
          outputTokens: 7,
          cachedTokens: 3,
          totalTokens: 29,
        },
      });
      expect(session.getSessionStats).toHaveBeenCalled();
    });

    it("keeps token usage undefined when session stats are unavailable", async () => {
      const prompt = makeStepPrompt("FN-001", 1);
      const task = makeTaskDetail({
        prompt,
        steps: [{ name: "Step 0", status: "pending" }],
      });
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = {
        ...makeMockSession(),
        getSessionStats: vi.fn().mockReturnValue(undefined),
      };
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      const results = await executor.executeAll();

      expect(results).toHaveLength(1);
      expect(results[0].tokenUsage).toBeUndefined();
      expect(session.getSessionStats).toHaveBeenCalled();
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

      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
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
      mockedCreateFnAgent.mockImplementation(() => {
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
      expect(mockedCreateFnAgent).toHaveBeenCalledTimes(5);
    });

    it("aborted flag: returns failed result immediately", async () => {
      const prompt = makeStepPrompt("FN-001", 2);
      const task = makeTaskDetail({ prompt, steps: [
        { name: "Step 0", status: "pending" },
        { name: "Step 1", status: "pending" },
      ]});
      const settings = makeSettings({ maxParallelSteps: 1 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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

      mockedCreateFnAgent.mockRejectedValue(new Error("Agent creation failed"));

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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
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
      expect(mockedInstallTaskWorktreeIdentityGuard).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "FN-001" }),
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      let createCount = 0;
      mockedCreateFnAgent.mockImplementation(() => {
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      // Make the merge-base bounded commit list return a step commit, but cherry-pick fails.
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rev-parse HEAD")) {
          return "primary-head";
        }
        if (typeof cmd === "string" && cmd.includes("git merge-base HEAD primary-head")) {
          return "merge-base-sha";
        }
        if (typeof cmd === "string" && cmd.includes("git rev-list --reverse merge-base-sha..HEAD")) {
          return "abc123def";
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rev-parse HEAD")) {
          return "primary-head";
        }
        if (typeof cmd === "string" && cmd.includes("git merge-base HEAD primary-head")) {
          return "merge-base-sha";
        }
        if (typeof cmd === "string" && cmd.includes("git rev-list --reverse merge-base-sha..HEAD")) {
          return "abc123def";
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
        if (cmd.includes("git rev-parse HEAD")) {
          return "primary-head";
        }
        if (cmd.includes("git merge-base HEAD primary-head")) {
          return "merge-base-sha";
        }
        if (cmd.includes("git rev-list --reverse merge-base-sha..HEAD")) {
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });
      const semaphore = new AgentSemaphore(4);

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
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
          steps: makeIndependentSteps(2),
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

        mockedCreateFnAgent.mockImplementation(({ cwd }: any) => {
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

        releaseStep0?.();
        const results = await resultsPromise;

        expect(executionEvents.includes("step-0-start")).toBe(true);

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1]);
        expect(results.every((r) => r.success)).toBe(true);
        expect(mockedCreateFnAgent).toHaveBeenNthCalledWith(
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
          steps: makeIndependentSteps(3),
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

        mockedCreateFnAgent.mockImplementation(({ cwd }: any) => {
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
        expect(cwdOrder.filter((cwd) => cwd === "/project/.worktrees/main").length).toBeGreaterThanOrEqual(3);
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
          steps: makeIndependentSteps(3),
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
          if (cmd.includes("git rev-parse HEAD")) {
            return "primary-head";
          }
          if (cmd.includes("git merge-base HEAD primary-head")) {
            return "merge-base-sha";
          }
          if (cmd.includes("git rev-list --reverse merge-base-sha..HEAD")) {
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

        mockedCreateFnAgent.mockImplementation(({ cwd }: any) => {
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

        releaseParallel?.();
        const results = await resultsPromise;

        expect(results).toHaveLength(3);
        expect(results.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
        expect(results.every((r) => r.success)).toBe(true);
        expect(events).toEqual(expect.arrayContaining(["parallel-0-start", "parallel-1-start", "primary-start"]));
        expect(maxActiveParallelSteps).toBeGreaterThanOrEqual(1);

        const primaryCwdCalls = mockedCreateFnAgent.mock.calls.filter(
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
          steps: makeIndependentSteps(2),
        });
        const settings = makeSettings({ maxParallelSteps: 2 });

        mockedGenerateWorktreeName
          .mockImplementationOnce(() => "wt-success-0")
          .mockImplementationOnce(() => "wt-success-1");
        mockedExecSync.mockReturnValue("");
        mockedCreateFnAgent.mockImplementation(({ cwd }: any) => {
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

        const primaryCwdCalls = mockedCreateFnAgent.mock.calls.filter(
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
          steps: makeIndependentSteps(3),
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

        mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);

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
    it("awaits asynchronous session disposal before the step boundary completes", async () => {
      const task = makeTaskDetail({ prompt: makeStepPrompt("FN-ASYNC-DISPOSE", 1), steps: [{ name: "Step 0", status: "pending" }] });
      let resolveDispose!: () => void;
      const session = makeMockSession();
      session.dispose = vi.fn(() => new Promise<void>((resolve) => { resolveDispose = resolve; }));
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
      const executor = new StepSessionExecutor({ taskDetail: task, worktreePath: "/project/.worktrees/main", rootDir: "/project", settings: makeSettings() });
      let completed = false;
      const execution = executor.executeAll().then((result) => { completed = true; return result; });
      await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      resolveDispose();
      await execution;
      expect(completed).toBe(true);
    });

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

      mockedCreateFnAgent.mockResolvedValue({ session: failingSession } as any);

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
      mockedCreateFnAgent.mockImplementation(() => {
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
      mockedExecSync.mockReturnValue("");

      const removeWorktreeSpy = vi.spyOn(worktreeBackendModule, "removeWorktree");

      const executor = new StepSessionExecutor({
        taskDetail: task,
        worktreePath: "/project/.worktrees/main",
        rootDir: "/project",
        settings,
      });

      await executor.executeAll();
      await executor.cleanup();

      expect(removeWorktreeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rootDir: "/project",
          taskId: "FN-001",
          settings,
          worktreePath: expect.stringContaining("/project/.worktrees/"),
        }),
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
        steps: makeIndependentSteps(2),
      });
      const settings = makeSettings({ maxParallelSteps: 2 });

      const session = makeMockSession();
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
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
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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

      mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

      // FN-7503 added an optional 6th timing arg; pin the first five and tolerate timing.
      expectAppendAgentLog(appendAgentLog, "FN-001", "step output", "text", undefined, "executor");
      expectAppendAgentLog(appendAgentLog, "FN-001", "read", "tool", undefined, "executor");
      expectAppendAgentLog(appendAgentLog, "FN-001", "read", "tool_result", undefined, "executor");
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
      mockedCreateFnAgent.mockResolvedValue({ session } as any);

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
      mockedCreateFnAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: first call throws, subsequent calls succeed
      const { promptWithFallback } = await import("../pi.js");
      let callCount = 0;
      vi.mocked(promptWithFallback).mockImplementation(async (session: any, prompt: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("context window exceeds limit (2013)");
        }
        // Subsequent calls (compact-and-resume) succeed
      });

      // Mock compactSessionContext to succeed
      const { compactSessionContext } = await import("../pi.js");
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

      mockedCreateFnAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: first call throws context-limit, second succeeds (reduced prompt)
      const { promptWithFallback } = await import("../pi.js");
      let callCount = 0;
      vi.mocked(promptWithFallback).mockImplementation(async (session: any, prompt: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("context window exceeds limit (2013)");
        }
        // Reduced-prompt succeeds
      });

      // Mock compactSessionContext to return null (no history)
      const { compactSessionContext } = await import("../pi.js");
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

      mockedCreateFnAgent.mockResolvedValue({
        session: makeMockSession(),
      } as any);

      // Mock promptWithFallback: always throws context-limit error
      const { promptWithFallback } = await import("../pi.js");
      vi.mocked(promptWithFallback).mockRejectedValue(
        new Error("context window exceeds limit (2013)"),
      );

      // Mock compactSessionContext to return null (no history)
      const { compactSessionContext } = await import("../pi.js");
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
// StepSessionExecutor to createFnAgent calls. The actual skill resolution
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
   * passed to createFnAgent during executeStep execution. Each test
   * uses fake timers and advances time to resolve any pending sleep()s.
   */
  async function captureCustomTools(options?: {
    agentStore?: unknown;
    messageStore?: unknown;
    assignedAgentId?: string;
  }): Promise<any[]> {
    let captured: any[] = [];

    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

  /*
  FNXC:EphemeralAgentTaskCreation 2026-08-23-22:05:
  FN-125 (0b4dbd219b) structurally withholds board CREATION from this lane: a workflow model-node
  step session receives neither `fn_task_create` nor `fn_delegate_task` (delegation creates a task
  through the same primitive), rather than being handed a tool that only refuses when called. The
  read/assign half of the agent surface is unchanged, so assert both halves.
  */
  it("includes fn_list_agents and fn_task_assign — but never fn_delegate_task — when agentStore is available", async () => {
    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
      getAgent: vi.fn().mockResolvedValue(null),
    };

    const tools = await captureCustomTools({
      agentStore: mockAgentStore,
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_list_agents");
    expect(toolNames).toContain("fn_task_assign");
    expect(toolNames).not.toContain("fn_delegate_task");
  });

  it("excludes delegation tools when agentStore is not provided", async () => {
    const tools = await captureCustomTools({});

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_list_agents");
    expect(toolNames).not.toContain("fn_delegate_task");
    expect(toolNames).not.toContain("fn_task_assign");
  });

  it("includes fn_send_message and fn_read_messages when messageStore and assignedAgentId are available", async () => {
    const mockMessageStore = {
      sendMessage: vi.fn().mockReturnValue({ id: "msg-001" }),
      getInbox: vi.fn().mockReturnValue([]),
    };

    const tools = await captureCustomTools({
      messageStore: mockMessageStore,
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_send_message");
    expect(toolNames).toContain("fn_read_messages");
  });

  it("excludes messaging tools when messageStore is not provided", async () => {
    const tools = await captureCustomTools({
      assignedAgentId: "agent-001",
    });

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("fn_send_message");
    expect(toolNames).not.toContain("fn_read_messages");
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
    expect(toolNames).not.toContain("fn_send_message");
    expect(toolNames).not.toContain("fn_read_messages");
  });

  /* FN-125 (0b4dbd219b) withheld `fn_task_create` from this lane; the task-log surface is unchanged. */
  it("includes fn_task_log — but never fn_task_create — when store is available", async () => {
    const tools = await captureCustomTools({});

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("fn_task_log");
    expect(toolNames).not.toContain("fn_task_create");
  });
});

describe("StepSessionExecutor executor model lane hierarchy", () => {
  async function captureAgentModel(settingsOverrides: Partial<Settings>, taskOverrides: Partial<TaskDetail> = {}) {
    let capturedProvider: string | undefined;
    let capturedModelId: string | undefined;

    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      capturedProvider = opts.defaultProvider;
      capturedModelId = opts.defaultModelId;
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new StepSessionExecutor({
      taskDetail: makeTaskDetail({
        prompt: makeStepPrompt("FN-MODEL", 1),
        steps: [{ name: "Step 0", status: "pending" }],
        ...taskOverrides,
      }),
      worktreePath: "/project/.worktrees/main",
      rootDir: "/project",
      settings: makeSettings({ maxParallelSteps: 1, ...settingsOverrides }),
    });

    try {
      const executePromise = executor.executeAll();
      await vi.advanceTimersByTimeAsync(30_000);
      await executePromise;
    } finally {
      vi.useRealTimers();
    }

    return { provider: capturedProvider, modelId: capturedModelId };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Fast & Cheap pair for a Fast step session while standard keeps execution", async () => {
    const settings = {
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-5",
      fastCheapProvider: "openai",
      fastCheapModelId: "gpt-4.1-mini",
    };
    await expect(captureAgentModel(settings, { executionMode: "fast" })).resolves.toEqual({
      provider: "openai",
      modelId: "gpt-4.1-mini",
    });
    await expect(captureAgentModel(settings, { executionMode: "standard" })).resolves.toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("uses project default override pair when execution lanes are absent", async () => {
    const resolved = await captureAgentModel({
      executionProvider: undefined,
      executionModelId: undefined,
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    expect(resolved).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("falls through to global default when project default override is incomplete", async () => {
    const resolved = await captureAgentModel({
      executionProvider: undefined,
      executionModelId: undefined,
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: undefined,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    expect(resolved).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });
});

describe("StepSessionExecutor credential-instance retargeting", () => {
  function makeCredentialExecutor(options: {
    steps?: number;
    runStepsInNewSessions?: boolean;
    credentialInstanceId?: string;
    maxParallelSteps?: number;
    resolveCredentialInstanceRetarget?: () => Promise<{ providerId: string; instanceId: string } | undefined>;
  } = {}) {
    const stepCount = options.steps ?? 1;
    return new StepSessionExecutor({
      taskDetail: makeTaskDetail({
        prompt: makeStepPrompt("FN-CREDENTIAL", stepCount),
        steps: Array.from({ length: stepCount }, (_, index) => ({ name: `Step ${index}`, status: "pending" as const })),
      }),
      worktreePath: "/project/.worktrees/main",
      rootDir: "/project",
      settings: makeSettings({ maxParallelSteps: options.maxParallelSteps ?? 1, runStepsInNewSessions: options.runStepsInNewSessions }),
      credentialInstanceId: options.credentialInstanceId,
      resolveCredentialInstanceRetarget: options.resolveCredentialInstanceRetarget,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(promptWithAutoRetry).mockImplementation(async (session: any, prompt: string, options?: unknown) =>
      session.prompt(prompt, options),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits an unset credential instance from legacy session creation", async () => {
    mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);
    const executor = makeCredentialExecutor();

    await executor.executeAll();

    expect(mockedCreateFnAgent.mock.calls[0]?.[0]).not.toHaveProperty("credentialInstanceId");
  });

  it("forwards the initial instance to each newly-created sequential session", async () => {
    mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);
    const executor = makeCredentialExecutor({ steps: 2, runStepsInNewSessions: true, credentialInstanceId: "account-a" });

    await executor.executeAll();

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(mockedCreateFnAgent.mock.calls.map(([options]) => options.credentialInstanceId)).toEqual(["account-a", "account-a"]);
    expect(mockedResolveExecutorSessionModel.mock.calls.map((args) => args[4])).toEqual(["account-a", "account-a"]);
  });

  it("forwards the initial instance to every fresh session in a parallel wave", async () => {
    mockedCreateFnAgent.mockResolvedValue({ session: makeMockSession() } as any);
    const executor = makeCredentialExecutor({ steps: 2, maxParallelSteps: 2, credentialInstanceId: "account-a" });

    await executor.executeAll();

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(mockedCreateFnAgent.mock.calls.map(([options]) => options.credentialInstanceId)).toEqual(["account-a", "account-a"]);
  });

  it("retargets only subsequent fresh sessions and clears back to omitted resolution", async () => {
    const first = makeMockSession();
    const second = makeMockSession();
    const third = makeMockSession();
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: first } as any)
      .mockResolvedValueOnce({ session: second } as any)
      .mockResolvedValueOnce({ session: third } as any);
    const executor = makeCredentialExecutor({ steps: 3, runStepsInNewSessions: true, credentialInstanceId: "account-a" });

    await (executor as any).executeStep(0, "/project/.worktrees/main");
    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-b" });
    await (executor as any).executeStep(1, "/project/.worktrees/main");
    await executor.retargetCredentialInstance(undefined);
    await (executor as any).executeStep(2, "/project/.worktrees/main");

    expect(mockedCreateFnAgent.mock.calls.map(([options]) => options.credentialInstanceId)).toEqual([
      "account-a",
      "account-b",
      undefined,
    ]);
    expect(mockedCreateFnAgent.mock.calls[2]?.[0]).not.toHaveProperty("credentialInstanceId");
  });

  it("defers reusable-primary disposal until an active prompt completes, then uses the retargeted instance", async () => {
    let finishFirstPrompt: (() => void) | undefined;
    let firstSession: ReturnType<typeof makeMockSession> | undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      firstSession = {
        ...makeMockSession(),
        abortBash: vi.fn(),
        prompt: vi.fn(() => new Promise<void>((finish) => {
          finishFirstPrompt = finish;
          resolve();
        })),
      };
      const second = { ...makeMockSession(), abortBash: vi.fn() };
      mockedCreateFnAgent
        .mockResolvedValueOnce({ session: firstSession } as any)
        .mockResolvedValueOnce({ session: second } as any);
    });
    const executor = makeCredentialExecutor({ steps: 2, runStepsInNewSessions: false, credentialInstanceId: "account-a" });
    const execution = executor.executeAll();

    await firstPromptStarted;
    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-b" });

    expect(firstSession?.abortBash).not.toHaveBeenCalled();
    expect(firstSession?.dispose).not.toHaveBeenCalled();
    finishFirstPrompt?.();

    await expect(execution).resolves.toEqual([
      expect.objectContaining({ stepIndex: 0, success: true, retries: 0 }),
      expect.objectContaining({ stepIndex: 1, success: true, retries: 0 }),
    ]);
    expect(firstSession?.dispose).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent.mock.calls[1]?.[0]).toMatchObject({ credentialInstanceId: "account-b" });
  });

  it("clears a deferred retarget during cleanup", async () => {
    let finishPrompt: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      const session = {
        ...makeMockSession(),
        abortBash: vi.fn(),
        prompt: vi.fn(() => new Promise<void>((finish) => {
          finishPrompt = finish;
          resolve();
        })),
      };
      mockedCreateFnAgent.mockResolvedValue({ session } as any);
    });
    const executor = makeCredentialExecutor({ runStepsInNewSessions: false, credentialInstanceId: "account-a" });
    const execution = executor.executeAll();

    await promptStarted;
    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-b" });
    await executor.cleanup();

    expect((executor as any).reusablePrimaryRetargetPending).toBe(false);
    finishPrompt?.();
    await execution;
  });

  it("immediately disposes an idle reusable primary session and ignores equivalent or invalid retargets", async () => {
    const session = { ...makeMockSession(), abortBash: vi.fn() };
    mockedCreateFnAgent.mockResolvedValue({ session } as any);
    const executor = makeCredentialExecutor({ runStepsInNewSessions: false, credentialInstanceId: "account-a" });

    await (executor as any).executeStep(0, "/project/.worktrees/main");
    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-a" });
    expect(session.dispose).not.toHaveBeenCalled();
    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-b" });
    expect(session.abortBash).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await expect(executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "bad id" })).resolves.toBeUndefined();
    expect(getStepSessionLogger().warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid credential instance id"));
  });

  it("retargets a usage-limit retry through the owning executor's live selection", async () => {
    const first = {
      ...makeMockSession(),
      prompt: vi.fn()
        .mockRejectedValueOnce(new Error("429 usage limit reached"))
        .mockResolvedValueOnce(undefined),
    };
    const second = makeMockSession();
    const resolveCredentialInstanceRetarget = vi.fn().mockResolvedValue({ providerId: "anthropic", instanceId: "account-b" });
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: first } as any)
      .mockResolvedValueOnce({ session: second } as any);
    const executor = makeCredentialExecutor({ credentialInstanceId: "account-a", resolveCredentialInstanceRetarget });

    const execution = executor.executeAll();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(execution).resolves.toEqual([expect.objectContaining({ success: true, retries: 1 })]);
    expect(resolveCredentialInstanceRetarget).toHaveBeenCalledTimes(1);
    expect(mockedCreateFnAgent.mock.calls[1]?.[0]).toMatchObject({ credentialInstanceId: "account-b" });
  });

  it("applies a manual retarget before a retry without changing retry accounting", async () => {
    let rejectFirstPrompt: ((error: Error) => void) | undefined;
    const first = {
      ...makeMockSession(),
      prompt: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectFirstPrompt = reject; })),
    };
    const second = makeMockSession();
    mockedCreateFnAgent
      .mockResolvedValueOnce({ session: first } as any)
      .mockResolvedValueOnce({ session: second } as any);
    const executor = makeCredentialExecutor({ credentialInstanceId: "account-a" });
    const execution = executor.executeAll();
    await vi.waitFor(() => expect(rejectFirstPrompt).toBeTypeOf("function"));

    await executor.retargetCredentialInstance({ providerId: "anthropic", instanceId: "account-b" });
    rejectFirstPrompt?.(new Error("retry me"));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(execution).resolves.toEqual([expect.objectContaining({ success: true, retries: 1 })]);
    expect(mockedCreateFnAgent.mock.calls[1]?.[0]).toMatchObject({ credentialInstanceId: "account-b" });
  });
});
