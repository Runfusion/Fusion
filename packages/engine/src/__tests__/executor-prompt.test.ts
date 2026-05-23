// -nocheck
/* eslint-disable -eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./executor-test-helpers.js";
import { AgentSemaphore } from "../concurrency.js";
import { detectReviewHandoffIntent, determineRevisionResetStart } from "../executor.js";
import { TaskExecutor, buildExecutionPrompt } from "../executor.js";
import { createFnAgent } from "../pi.js";
import { reviewStep as mockedReviewStepFn } from "../reviewer.js";
import { execSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { findWorktreeUser, aiMergeTask } from "../merger.js";
import { WorktreePool } from "../worktree-pool.js";
import { generateWorktreeName, slugify } from "../worktree-names.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { StepSessionExecutor } from "../step-session-executor.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../verification-utils.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedSessionManager,
  mockedGenerateWorktreeName,
  mockedFindWorktreeUser,
  mockedStepSessionExecutor,
  mockedWithRateLimitRetry,
  mockedExecSync,
  mockedExistsSync,
  mockExecuteAll,
  mockTerminateAllSessions,
  mockCleanup,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-001",
    title: "Test Task",
    description: "A test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildExecutionPrompt", () => {
  it("includes attachment section with absolute paths for image attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc123-screenshot.png", originalName: "screenshot.png", mimeType: "image/png", size: 2048, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**screenshot.png** (screenshot)");
    expect(result).toContain("/home/user/project/.fusion/tasks/FN-001/attachments/abc123-screenshot.png");
  });

  it("includes attachment section with absolute paths for text attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "def456-error.log", originalName: "error.log", mimeType: "text/plain", size: 512, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**error.log** (text/plain)");
    expect(result).toContain("read for context");
    expect(result).toContain("/home/user/project/.fusion/tasks/FN-001/attachments/def456-error.log");
  });

  it("includes both image and text attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc-shot.png", originalName: "shot.png", mimeType: "image/png", size: 1024, createdAt: new Date().toISOString() },
        { filename: "def-config.json", originalName: "config.json", mimeType: "application/json", size: 256, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("**shot.png** (screenshot)");
    expect(result).toContain("**config.json** (application/json)");
  });

  it("rewrites project-root absolute paths to the active worktree", () => {
    const task = createMockTaskDetail({
      prompt: [
        "# test",
        "## Context to Read First",
        "- `/home/user/project/web/app/page.tsx`",
        "- `/home/user/project/.fusion/memory/`",
        "## Steps",
        "### Step 0: Preflight",
        "- [ ] inspect `/home/user/project/web/app/layout.tsx`",
      ].join("\n"),
    });

    const result = buildExecutionPrompt(
      task,
      "/home/user/project",
      undefined,
      "/home/user/project/.worktrees/happy-robin",
    );

    expect(result).toContain("/home/user/project/.worktrees/happy-robin/web/app/page.tsx");
    expect(result).toContain("/home/user/project/.worktrees/happy-robin/web/app/layout.tsx");
    expect(result).toContain("/home/user/project/.fusion/memory/");
    expect(result).not.toContain("/home/user/project/.worktrees/happy-robin/.fusion/memory/");
  });

  it("omits attachment section when no attachments", () => {
    const task = createMockTaskDetail({ attachments: [] });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachment section when attachments is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachment section when rootDir is not provided", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc.png", originalName: "test.png", mimeType: "image/png", size: 1024, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Attachments");
  });

  it("includes Project Commands section with test command when settings.testCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Test:** `pnpm test`");
    expect(result).not.toContain("- **Build:**");
  });

  it("includes Project Commands section with build command when settings.buildCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      buildCommand: "pnpm build",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Build:** `pnpm build`");
    expect(result).not.toContain("- **Test:**");
  });

  it("includes both commands when both are set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Test:** `pnpm test`");
    expect(result).toContain("- **Build:** `pnpm build`");
  });

  it("tells executors to fix quality-gate failures even outside initial file scope", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    } as any);

    expect(result).toContain("fix failures even when that requires edits outside the original File Scope");
    expect(result).toContain("If the repo has a typecheck command, run it before `fn_task_done()`");
    expect(result).toContain("not for fixes required to get tests, build, or typecheck back to green");
  });

  it("requires resolving ALL test failures, including unrelated or pre-existing ones", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    } as any);

    // The stricter language must be present to prevent "unrelated failure" deferrals
    expect(result).toContain("Resolve ALL test failures");
    expect(result).toContain("even if they appear unrelated or pre-existing");
    expect(result).toContain("accumulate technical debt");
    expect(result).toContain("Investigate and fix or suppress them");
    expect(result).toContain("do not defer them to a separate task");
  });

  it("includes source issue reference in commit instruction when task has github sourceIssue", () => {
    const task = createMockTaskDetail({
      sourceIssue: {
        provider: "github",
        repository: "runfusion/fusion",
        externalIssueId: "2915",
        issueNumber: 2915,
      },
    } as any);

    const result = buildExecutionPrompt(task, "/home/user/project");
    expect(result).toContain('git commit -m "feat(FN-001): complete Step N — <short summary>" -m "Ref: runfusion/fusion#2915"');
  });

  it("falls back to externalIssueId for commit source issue reference when issueNumber is missing", () => {
    const task = createMockTaskDetail({
      sourceIssue: {
        provider: "github",
        repository: "runfusion/fusion",
        externalIssueId: "2915",
      },
    } as any);

    const result = buildExecutionPrompt(task, "/home/user/project");
    expect(result).toContain('git commit -m "feat(FN-001): complete Step N — <short summary>" -m "Ref: runfusion/fusion#2915"');
  });

  it("omits source issue reference from commit instruction when sourceIssue is missing", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain('git commit -m "feat(FN-001): complete Step N — <short summary>"');
    expect(result).not.toContain(' -m "Ref:');
  });

  it("requires a short summary in the execution prompt begin block", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain('git commit -m "feat(FN-001): complete Step N — <short summary>"');
    expect(result).toContain("The `<short summary>` is required");
    expect(result).toContain("concrete 5–10 word description of what the step changed");
  });

  it("keeps the executor source prompt wording and examples for commit summaries", async () => {
    const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const executorSource = readFileSync(new URL("../executor.ts", import.meta.url), "utf8");

    expect(executorSource).toContain("Always include a short, specific summary after the em dash (5–10 words)");
    expect(executorSource).toContain("Do NOT commit just \\`complete Step N\\`");
    expect(executorSource).toContain("\\`feat(FN-1234): complete Step 4 — tighten prompt examples for commit summaries\\`");
    expect(executorSource).toContain("\\`feat(FN-1234): complete Step 2\\`");
  });

  it("omits Project Commands section when neither command is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {} as any);

    expect(result).not.toContain("## Project Commands");
  });

  it("omits Project Commands section when settings is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Project Commands");
  });

  it("includes Steering Comments section when steeringComments has entries", () => {
    const task = createMockTaskDetail({
      steeringComments: [
        {
          id: "1",
          text: "Please handle the edge case",
          createdAt: new Date().toISOString(),
          author: "user" as const,
        },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).toContain("## Steering Comments");
    expect(result).toContain("**user**");
    expect(result).toContain("> Please handle the edge case");
    expect(result).toContain("The following comments were added by the user during execution");
  });

  it("formats multiple steering comments correctly", () => {
    const now = new Date();
    const task = createMockTaskDetail({
      steeringComments: [
        {
          id: "1",
          text: "First comment",
          createdAt: new Date(now.getTime() - 60000).toISOString(), // 1 minute ago
          author: "user" as const,
        },
        {
          id: "2",
          text: "Second comment",
          createdAt: now.toISOString(),
          author: "agent" as const,
        },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).toContain("**user**");
    expect(result).toContain("**agent**");
    expect(result).toContain("> First comment");
    expect(result).toContain("> Second comment");
  });

  it("omits Steering Comments section when steeringComments is empty", () => {
    const task = createMockTaskDetail({ steeringComments: [] });
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Steering Comments");
  });

  it("omits Steering Comments section when steeringComments is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Steering Comments");
  });

  it("includes only the 10 most recent steering comments", () => {
    const steeringComments = Array.from({ length: 15 }, (_, i) => ({
      id: `${i}`,
      text: `Comment ${i}`,
      createdAt: new Date().toISOString(),
      author: "user" as const,
    }));

    const task = createMockTaskDetail({ steeringComments });
    const result = buildExecutionPrompt(task);

    // Should include comments 5-14 (the 10 most recent), not 0-4
    expect(result).toContain("> Comment 5");
    expect(result).toContain("> Comment 14");
    expect(result).not.toContain("> Comment 0");
    expect(result).not.toContain("> Comment 4");
  });

  it("end-to-end: steering comments are fully injected into execution prompt with correct format", () => {
    const now = new Date();
    const task = createMockTaskDetail({
      id: "FN-123",
      title: "Verify Steering Feature",
      steeringComments: [
        {
          id: "sc-001",
          text: "Please ensure all edge cases are handled in the validation logic",
          createdAt: new Date(now.getTime() - 120000).toISOString(),
          author: "user" as const,
        },
        {
          id: "sc-002",
          text: "Consider adding unit tests for the new utility function",
          createdAt: new Date(now.getTime() - 60000).toISOString(),
          author: "agent" as const,
        },
        {
          id: "sc-003",
          text: "Don't forget to update the documentation before completing",
          createdAt: now.toISOString(),
          author: "user" as const,
        },
      ],
    });

    const result = buildExecutionPrompt(task, "/project", { testCommand: "pnpm test" } as any);

    // Verify section header exists
    expect(result).toContain("## Steering Comments");

    // Verify explanatory header text
    expect(result).toContain("The following comments were added by the user during execution");
    expect(result).toContain("Consider adjusting your approach or replanning remaining steps based on this feedback");

    // Verify all three comments appear with correct author badges
    expect(result).toContain("**user**");
    expect(result).toContain("**agent**");

    // Verify quoted text format
    expect(result).toContain("> Please ensure all edge cases are handled in the validation logic");
    expect(result).toContain("> Consider adding unit tests for the new utility function");
    expect(result).toContain("> Don't forget to update the documentation before completing");

    // Verify timestamp formatting appears (either relative like "2m ago" or absolute)
    // The formatTimestamp function returns relative times for recent comments
    expect(result).toMatch(/\*\*user\*\* — \d+m? ago/);

    // Verify the section appears in the expected location (after progress section, before review level)
    const steeringSectionIndex = result.indexOf("## Steering Comments");
    const reviewLevelIndex = result.indexOf("## Review level");
    expect(steeringSectionIndex).toBeGreaterThan(0);
    expect(reviewLevelIndex).toBeGreaterThan(steeringSectionIndex);
  });

  it("passes settings to buildExecutionPrompt in TaskExecutor.execute()", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "npm test",
      buildCommand: "npm run build",
    });

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: mockPrompt,
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Called four times: initial execution + 3 retries when agent finishes without fn_task_done
    expect(mockPrompt).toHaveBeenCalledTimes(4);
    const agentPrompt = mockPrompt.mock.calls[0][0];
    expect(agentPrompt).toContain("## Project Commands");
    expect(agentPrompt).toContain("- **Test:** `npm test`");
    expect(agentPrompt).toContain("- **Build:** `npm run build`");
  });

  describe("memoryEnabled setting", () => {
    it("includes memory instructions when memoryEnabled: true", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
      } as any);
      expect(result).toContain("Execute this task.");
      expect(result).toContain("## Project Memory");
      expect(result).toContain(".fusion/memory/");
    });

    it("excludes memory instructions when memoryEnabled: false", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: false,
      } as any);
      expect(result).toContain("Execute this task.");
      expect(result).not.toContain("## Project Memory");
    });

    it("includes memory instructions when memoryEnabled is undefined (default enabled)", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {} as any);
      expect(result).toContain("Execute this task.");
      expect(result).toContain("## Project Memory");
      expect(result).toContain(".fusion/memory/");
    });

    it("includes selective memory write instruction for durable learnings at end of execution", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
      } as any);
      // Should instruct selective writes, not unconditional appends
      expect(result).toMatch(/skip.*memory.*update|selectively|durable.*learnings/i);
      expect(result).toMatch(/end of execution|before calling.*fn_task_done/i);
      // Should distinguish agent-private vs project-shared memory scope
      expect(result).toContain('fn_memory_append(scope="agent")');
      expect(result).toContain('fn_memory_append(scope="project")');
      // Should forbid task-specific trivia
      expect(result).toMatch(/avoid.*trivia|task-specific.*trivia|per-task.*log/i);
      // Should allow consolidation/editing
      expect(result).toMatch(/consolidate|update.*refine.*existing|edit.*existing/i);
    });

    it("uses project-root memory path not worktree-local path", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
      } as any);
      expect(result).toContain("`.fusion/memory/`");
    });
  });

  describe("memoryBackendType setting", () => {
    it("includes .fusion/memory/ for file backend", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
        memoryBackendType: "file",
      } as any);
      expect(result).toContain("## Project Memory");
      // Check that the Project Memory section contains .fusion/memory/
      const memorySectionMatch = result.match(/## Project Memory\n([\s\S]*?)(?=\n## [^#]|$)/);
      expect(memorySectionMatch).toBeTruthy();
      expect(memorySectionMatch![1]).toContain(".fusion/memory/");
    });

    it("includes read-only wording for readonly backend without write directives in memory section", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
        memoryBackendType: "readonly",
      } as any);
      expect(result).toContain("## Project Memory");
      // Extract the Project Memory section
      const memorySectionMatch = result.match(/## Project Memory\n([\s\S]*?)(?=\n## [^#]|$)/);
      expect(memorySectionMatch).toBeTruthy();
      const memorySection = memorySectionMatch![1];
      // Should NOT contain write/update directives in the memory section
      expect(memorySection).not.toMatch(/write.*memory|update.*memory/i);
      // Should NOT contain the specific file path in the memory section
      expect(memorySection).not.toContain(".fusion/memory/");
    });

    it("does not include .fusion/memory/ in Project Memory section for qmd backend", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
        memoryBackendType: "qmd",
      } as any);
      expect(result).toContain("## Project Memory");
      // Extract the Project Memory section
      const memorySectionMatch = result.match(/## Project Memory\n([\s\S]*?)(?=\n## [^#]|$)/);
      expect(memorySectionMatch).toBeTruthy();
      const memorySection = memorySectionMatch![1];
      // QMD should NOT unconditionally reference .fusion/memory/ in the memory section
      expect(memorySection).not.toContain(".fusion/memory/");
      expect(memorySection).toContain("fn_memory_search");
      expect(memorySection).toContain("fn_memory_get");
    });

    it("QMD prompt has actionable memory instructions", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
        memoryBackendType: "qmd",
      } as any);
      expect(result).toContain("## Project Memory");
      // Extract the Project Memory section
      const memorySectionMatch = result.match(/## Project Memory\n([\s\S]*?)(?=\n## [^#]|$)/);
      expect(memorySectionMatch).toBeTruthy();
      const memorySection = memorySectionMatch![1];
      // QMD should NOT contain .fusion/memory/
      expect(memorySection).not.toContain(".fusion/memory/");
      expect(memorySection).toContain("fn_memory_search");
      // Contains "end of execution" write guidance
      expect(memorySection).toMatch(/end of execution/i);
    });

    it("excludes memory section when memoryEnabled: false regardless of backend", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: false,
        memoryBackendType: "file",
      } as any);
      expect(result).toContain("Execute this task.");
      expect(result).not.toContain("## Project Memory");
    });
  });

  describe("commit co-author attribution", () => {
    it("includes default co-author trailer in commit instruction when commitAuthorEnabled is true", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        commitAuthorEnabled: true,
      } as any);
      expect(result).toContain('-m "Co-authored-by: Fusion <noreply@runfusion.ai>"');
      expect(result).not.toContain("--author=");
    });

    it("includes custom co-author name and email in commit instruction", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        commitAuthorEnabled: true,
        commitAuthorName: "CustomBot",
        commitAuthorEmail: "bot@example.com",
      } as any);
      expect(result).toContain('-m "Co-authored-by: CustomBot <bot@example.com>"');
    });

    it("omits co-author trailer from commit instruction when commitAuthorEnabled is false", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        commitAuthorEnabled: false,
      } as any);
      expect(result).not.toContain("Co-authored-by");
      expect(result).not.toContain("--author");
      // Should still contain commit instruction without co-author
      expect(result).toContain("git commit -m");
    });

    it("uses default co-author when commitAuthorEnabled is true but name/email are undefined", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        commitAuthorEnabled: true,
        commitAuthorName: undefined,
        commitAuthorEmail: undefined,
      } as any);
      expect(result).toContain('-m "Co-authored-by: Fusion <noreply@runfusion.ai>"');
    });

    it("uses default co-author when settings is undefined", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project");
      expect(result).toContain('-m "Co-authored-by: Fusion <noreply@runfusion.ai>"');
    });

    it("uses default co-author when settings is empty object", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {} as any);
      expect(result).toContain('-m "Co-authored-by: Fusion <noreply@runfusion.ai>"');
    });
  });
});

// Import the summarizeToolArgs helper directly (not affected by mocks above)
describe("summarizeToolArgs", () => {
  // Dynamic import to avoid mock interference
  let summarizeToolArgs: (name: string, args?: Record<string, unknown>) => string | undefined;

  beforeEach(async () => {
    const mod = await vi.importActual<typeof import("../executor.js")>("../executor.js");
    summarizeToolArgs = mod.summarizeToolArgs;
  });

  it("returns command for bash tool", () => {
    expect(summarizeToolArgs("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs("bash", { command: "echo hello" })).toBe("echo hello");
  });

  it("returns long bash commands in full without truncation", () => {
    const longCmd = "a".repeat(100);
    const result = summarizeToolArgs("Bash", { command: longCmd });
    expect(result).toBe(longCmd);
  });

  it("returns path for read/edit/write tools", () => {
    expect(summarizeToolArgs("Read", { path: "src/types.ts" })).toBe("src/types.ts");
    expect(summarizeToolArgs("edit", { path: "src/store.ts" })).toBe("src/store.ts");
    expect(summarizeToolArgs("Write", { path: "out.txt", content: "data" })).toBe("out.txt");
  });

  it("returns first string arg for unknown tools", () => {
    expect(summarizeToolArgs("fn_task_update", { step: 1, status: "done" })).toBe("done");
  });

  it("returns undefined when no args provided", () => {
    expect(summarizeToolArgs("Bash")).toBeUndefined();
    expect(summarizeToolArgs("Bash", {})).toBeUndefined();
  });

  it("returns undefined when no string args found", () => {
    expect(summarizeToolArgs("unknown", { count: 42, flag: true })).toBeUndefined();
  });
});

describe("TaskExecutor pause behavior", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("terminates agent and moves task to todo when paused during execution", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateFnAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause happening during agent execution
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
            // Simulate the dispose causing an error (session terminated)
            throw new Error("Session terminated");
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should move to todo, NOT mark as failed. This path (agent threw mid-
    // execution while paused) explicitly nukes worktree+branch — work is
    // discarded — so it must NOT flag preserveResumeState.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("does not move to in-review when paused during execution (graceful session end)", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause — session ends gracefully (no throw)
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should NOT move to in-review (paused tasks skip that logic)
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    // Should move to todo instead (regression: was stranding in in-progress).
    // Pause-graceful path flags preserveResumeState so the bounce keeps
    // the worktree and accumulated step progress.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("moves paused task to todo when session ends gracefully (regression for FN-827)", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateFnAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause during execution — session ends gracefully (no throw)
            store._trigger("task:updated", { id: "FN-805", paused: true, column: "in-progress" });
            // No error thrown — this is the "graceful exit" path
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const stuckTaskDetector = { trackTask: vi.fn(), untrackTask: vi.fn(), recordActivity: vi.fn() } as any;

    const executor = new TaskExecutor(store, "/tmp/test", { stuckTaskDetector });
    await executor.execute({
      id: "FN-805",
      title: "Stranded task",
      description: "A task that was paused and stranded",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // The critical fix: task must end in todo, not stranded in in-progress.
    // The pause path must also flag preserveResumeState so the move does not
    // wipe accumulated step progress and the worktree pointer.
    expect(store.moveTask).toHaveBeenCalledWith("FN-805", "todo", { preserveResumeState: true });
    // Should NOT be marked as failed
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-805", expect.objectContaining({ status: "failed" }));
    // Should log the pause event
    expect(store.logEntry).toHaveBeenCalledWith("FN-805", expect.stringContaining("Execution paused"));
    // Session should be disposed
    expect(disposeFn).toHaveBeenCalled();
    // Stuck detector should have untracked the task
    expect(stuckTaskDetector.untrackTask).toHaveBeenCalledWith("FN-805");
  });

  it("handles rapid pause→unpause without duplicate executor runs", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();
    let promptCallCount = 0;

    mockedCreateFnAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            promptCallCount++;
            // Simulate pause during execution
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
            // Simulate rapid unpause while executor is still handling the pause
            store._trigger("task:updated", { id: "FN-001", paused: undefined, column: "in-progress" });
            // Session ends gracefully (no throw)
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Rapid pause/unpause",
      description: "Test rapid pause then unpause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // The task should still be moved to todo exactly once (the pause took effect)
    // Even if unpause happened rapidly, the session was already disposed
    const todoCalls = store.moveTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1] === "todo",
    );
    expect(todoCalls.length).toBe(1);
    // Should NOT have duplicate in-review calls
    const inReviewCalls = store.moveTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1] === "in-review",
    );
    expect(inReviewCalls.length).toBe(0);
    // Agent should only have been prompted once
    expect(promptCallCount).toBe(1);
  });

  it("skips paused tasks during resumeOrphaned", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      { id: "FN-001", column: "in-progress", paused: true, title: "Paused task", steps: [], description: "", dependencies: [] },
      { id: "FN-002", column: "in-progress", paused: false, title: "Active task", steps: [], description: "", dependencies: [] },
    ]);

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    // Only KB-002 should be resumed (KB-001 is paused)
    expect(store.logEntry).toHaveBeenCalledWith("FN-002", "Resumed after engine restart");
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-001", expect.anything());
  });

  it("skips resumeOrphaned entirely while enginePaused is active", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: false,
      enginePaused: true,
      globalPause: false,
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("resumes unpaused in-progress task with no active session", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: disposeFn,
      },
    }) as any);

    const _executor = new TaskExecutor(store, "/tmp/test");

    // Simulate unpause of an in-progress task that has no active session
    // (e.g., engine restarted while task was paused in-progress)
    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "in-progress",
      description: "Test task",
      title: "Resumed task",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for async execution to start
    await new Promise((r) => setTimeout(r, 50));

    // Agent created at least twice: initial resume + retry when agent finishes without fn_task_done
    // (async worktree validation may allow additional retry cycles within the timeout)
    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Resuming execution after unpause", undefined, undefined);
  });

  it("does not resume unpaused in-progress task while global pause is active", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
    });

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "in-progress",
      description: "Test task",
      title: "Paused runtime task",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(executor).toBeTruthy();
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-001", "Resuming execution after unpause", undefined, undefined);
  });

  it("does not recursively resume when resume logging emits task updated", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      paused: undefined,
      column: "in-progress",
      description: "Test task",
      title: "Resumed task",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    let emittedUpdateFromLog = false;
    store.logEntry.mockImplementation(async (_id: string, action: string) => {
      if (action === "Resuming execution after unpause" && !emittedUpdateFromLog) {
        emittedUpdateFromLog = true;
        store._trigger("task:updated", { ...task, updatedAt: new Date().toISOString() });
      }
    });

    new TaskExecutor(store, "/tmp/test");
    store._trigger("task:updated", task);

    await new Promise((r) => setTimeout(r, 50));

    const resumeLogCalls = store.logEntry.mock.calls.filter(
      ([id, action]: [string, string]) => id === "FN-001" && action === "Resuming execution after unpause",
    );
    expect(resumeLogCalls).toHaveLength(1);
  });

  it("clears stale failed state before resuming unpaused in-progress task", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    const _executor = new TaskExecutor(store, "/tmp/test");

    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "in-progress",
      status: "failed",
      error: "Request was aborted.",
      description: "Test task",
      title: "Resumed task",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: null, error: null });
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Resuming execution after unpause", undefined, undefined);
  });

  it("clears stale failed state before resuming orphaned in-progress task", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      {
        id: "FN-001",
        column: "in-progress",
        paused: false,
        status: "failed",
        error: "Request was aborted.",
        title: "Active task",
        steps: [],
        description: "",
        dependencies: [],
      },
    ]);

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: null, error: null });
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Resumed after engine restart");
  });

  it("does not duplicate execution when unpausing already-executing task", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate rapid unpause during execution — should NOT start a second run
          store._trigger("task:updated", {
            id: "FN-001",
            paused: undefined,
            column: "in-progress",
          });
          // Wait a bit to let the unpause handler run
          await new Promise((r) => setTimeout(r, 10));
        }),
        dispose: disposeFn,
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Already executing",
      description: "Test no duplicate",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // At least two agent creations (initial + retry without fn_task_done), but no duplicate from the unpause event
    // (async worktree validation may allow additional retry cycles)
    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not resume unpaused task that is not in-progress", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    const _executor = new TaskExecutor(store, "/tmp/test");

    // Unpause a todo task — executor should NOT try to execute it
    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "todo",
    });

    await new Promise((r) => setTimeout(r, 20));

    // No agent should have been created
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
  });

  it("does not resume unpaused task that still has an active session", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    let promptResolve: () => void;
    const promptPromise = new Promise<void>((r) => { promptResolve = r; });

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate unpause while session is still active (should be a no-op)
          store._trigger("task:updated", {
            id: "FN-001",
            paused: undefined,
            column: "in-progress",
          });
          await new Promise((r) => setTimeout(r, 10));
        }),
        dispose: disposeFn,
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Start execution — session will be active
    const executePromise = executor.execute({
      id: "FN-001",
      title: "Active session",
      description: "Test active session unpause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await executePromise;

    // Four agent sessions (initial + 3 retries without fn_task_done) — the unpause during active session was a no-op
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(4);
  });

  it("uses SessionManager.create for fresh execution and persists sessionFile", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_123.jsonl";

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Fresh task",
      description: "Test fresh session",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should use SessionManager.create for fresh execution
    expect(mockedSessionManager.create).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees"),
    );
    expect(mockedSessionManager.open).not.toHaveBeenCalled();

    // Should persist the session file path on the task
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { sessionFile: sessionFilePath });
  });

  it("uses SessionManager.open to resume session when task has sessionFile", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_123.jsonl";
    const resumePromptFn = vi.fn().mockResolvedValue(undefined);

    // existsSync must return true for the session file
    mockedExistsSync.mockReturnValue(true);

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: resumePromptFn,
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Resumed task",
      description: "Test session resume",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      sessionFile: sessionFilePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should use SessionManager.open for the initial resumed execution
    expect(mockedSessionManager.open).toHaveBeenCalledWith(sessionFilePath);

    // The first createFnAgent call should use the opened session manager
    const firstCall = mockedCreateFnAgent.mock.calls[0][0] as any;
    expect(firstCall.sessionManager).toBeDefined();

    // The log should indicate resume
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Resumed agent session after unpause"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("preserves sessionFile when task is paused (graceful exit)", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_456.jsonl";

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate pause — session ends gracefully
          store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
        }),
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Pauseable task",
      description: "Test session file preserved on pause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Session file should NOT be cleared when paused
    const clearCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1]?.sessionFile === null,
    );
    expect(clearCalls.length).toBe(0);

    // Task should be moved to todo (ready for resume) with preserveResumeState
    // so step progress and the worktree survive the pause→unpause hop.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveResumeState: true });
  });

  it("falls back to fresh session when sessionFile no longer exists on disk", async () => {
    const store = createMockStore();
    const staleSessionFile = "/tmp/sessions/deleted_session.jsonl";

    // Session file does NOT exist on disk
    mockedExistsSync.mockImplementation(
      (p) => p !== staleSessionFile,
    );

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
      sessionFile: "/tmp/sessions/new_session.jsonl",
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Stale session",
      description: "Test stale session file fallback",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      sessionFile: staleSessionFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should fall back to SessionManager.create (not open)
    expect(mockedSessionManager.create).toHaveBeenCalled();
    expect(mockedSessionManager.open).not.toHaveBeenCalled();
  });

  it("does not resume stale sessionFile when persisted worktree path mismatches live task worktree", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/fn-4031-stale-session.jsonl";
    await writeFile(sessionFilePath, JSON.stringify({ cwd: "/tmp/test/.worktrees/bright-wren" }), "utf-8");

    mockedExistsSync.mockImplementation((p) => String(p) !== "/tmp/test/.worktrees/fn-001");

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
      sessionFile: "/tmp/sessions/new_session.jsonl",
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Stale resumed session",
      description: "Test stale worktree session mismatch fallback",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      worktree: "/tmp/test/.worktrees/fn-001",
      sessionFile: sessionFilePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedSessionManager.open).not.toHaveBeenCalled();
    expect(mockedSessionManager.create).toHaveBeenCalledWith("/tmp/test/.worktrees/fn-001");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { sessionFile: null });

    await rm(sessionFilePath, { force: true });
  });
});

describe("swallowed async store failure observability", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedWithRateLimitRetry.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  it("logs warning when rate-limit retry logEntry fails in step-session mode", async () => {
    const warnSpy = vi.spyOn(executorLog, "warn");
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      runStepsInNewSessions: true,
      maxParallelSteps: 2,
    });
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Rate-limit step-session task",
      description: "Rate-limit diagnostics",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 0", status: "pending" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseCommitSha: "abc123",
      enabledWorkflowSteps: [],
    });

    mockExecuteAll.mockResolvedValue([{ stepIndex: 0, success: true, retries: 0 }]);

    store.logEntry.mockImplementation(async (_taskId: string, message: string) => {
      if (message.includes("Rate limited — retry")) {
        throw new Error("step-session retry log failure");
      }
      return undefined;
    });

    mockedWithRateLimitRetry.mockImplementationOnce((async (
      fn: () => Promise<unknown>,
      options?: { onRetry?: (attempt: number, delayMs: number, error: Error) => void },
    ) => {
      options?.onRetry?.(2, 4_000, new Error("rate limit"));
      return fn();
    }) as typeof withRateLimitRetry);

    const executor = new TaskExecutor(store, "/tmp/test");
    await expect(executor.execute({
      id: "FN-001",
      title: "Rate-limit step-session task",
      description: "Rate-limit diagnostics",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 0", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).resolves.toBeUndefined();

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-001 failed to log rate-limit retry: step-session retry log failure"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when rate-limit retry logEntry fails in main-agent mode", async () => {
    const warnSpy = vi.spyOn(executorLog, "warn");
    const store = createMockStore();
    let capturedCustomTools: Array<{ name: string; execute: (callId: string, args: Record<string, unknown>) => Promise<unknown> }> = [];

    store.logEntry.mockImplementation(async (_taskId: string, message: string) => {
      if (message.includes("Rate limited — retry")) {
        throw new Error("main-agent retry log failure");
      }
      return undefined;
    });

    mockedCreateFnAgent.mockImplementation((async (opts: { customTools?: typeof capturedCustomTools }) => {
      capturedCustomTools = opts.customTools ?? [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = capturedCustomTools.find((tool) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
        sessionFile: "/tmp/sessions/main-agent-rate-limit.jsonl",
      };
    }) as any);

    mockedWithRateLimitRetry.mockImplementationOnce((async (
      fn: () => Promise<unknown>,
      options?: { onRetry?: (attempt: number, delayMs: number, error: Error) => void },
    ) => {
      options?.onRetry?.(1, 3_000, new Error("rate limit"));
      return fn();
    }) as typeof withRateLimitRetry);

    const executor = new TaskExecutor(store, "/tmp/test");
    await expect(executor.execute({
      id: "FN-001",
      title: "Rate-limit main-agent task",
      description: "Rate-limit diagnostics",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 0", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).resolves.toBeUndefined();

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-001 failed to log rate-limit retry: main-agent retry log failure"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when sessionFile update fails during retry", async () => {
    const warnSpy = vi.spyOn(executorLog, "warn");
    const store = createMockStore();
    const retrySessionFilePath = "/tmp/sessions/retry-failed.jsonl";

    store.updateTask.mockImplementation(async (_taskId: string, patch: Record<string, unknown>) => {
      if (patch?.sessionFile === retrySessionFilePath) {
        throw new Error("retry sessionFile write failed");
      }
      return {};
    });

    mockedCreateFnAgent
      .mockResolvedValueOnce({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
        sessionFile: "/tmp/sessions/initial.jsonl",
      } as any)
      .mockResolvedValueOnce({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
        sessionFile: retrySessionFilePath,
      } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await expect(executor.execute({
      id: "FN-001",
      title: "Retry session task",
      description: "Session retry diagnostics",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).resolves.toBeUndefined();

    expect(mockedCreateFnAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-001 failed to persist retry sessionFile: retry sessionFile write failed"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when sessionFile clear fails on completion", async () => {
    const warnSpy = vi.spyOn(executorLog, "warn");
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    store.updateTask.mockImplementation(async (_taskId: string, patch: Record<string, unknown>) => {
      if (patch?.sessionFile === null) {
        throw new Error("session clear failed");
      }
      return {};
    });

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
        sessionFile: "/tmp/sessions/clear-test.jsonl",
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await expect(executor.execute({
      id: "FN-001",
      title: "Session clear task",
      description: "Session clear diagnostics",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).resolves.toBeUndefined();

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("FN-001 failed to clear sessionFile: session clear failed"),
    );

    warnSpy.mockRestore();
  });

  it("logs warning when child agent deletion fails during cleanup", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(executorLog, "warn");

    try {
      const store = createMockStore();
      const agentStore = {
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        deleteAgent: vi.fn().mockRejectedValue(new Error("delete failed")),
      };

      const executor = new TaskExecutor(store, "/tmp/test", {
        agentStore: agentStore as any,
      });

      (executor as any).childSessions.set("child-007", {
        dispose: vi.fn(),
      });

      await (executor as any).terminateChildAgent("child-007");
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete spawned agent child-007: delete failed"),
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("TaskExecutor executor model hot-swap", () => {
  const buildUpdatedTask = (overrides: Partial<Task> = {}): Task => ({
    id: "FN-001",
    title: "Model task",
    description: "Test model updates",
    column: "in-progress",
    paused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  const flushTaskUpdated = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  beforeEach(() => {
    resetExecutorMocks();
  });

  it("hot-swaps executor model on active session when modelProvider/modelId change", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const findModel = vi.fn().mockReturnValue({
      provider: { name: "openai" },
      id: "gpt-4o",
      name: "GPT-4o",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-sonnet-4-5",
      lastTaskModelProvider: "anthropic",
      lastTaskModelId: "claude-sonnet-4-5",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: "openai",
      modelId: "gpt-4o",
    }));

    await flushTaskUpdated();

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({ name: "openai" }),
      id: "gpt-4o",
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Model changed to openai/gpt-4o", undefined, undefined);
  });

  it("does not attempt hot-swap when no active session exists", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);

    new TaskExecutor(store, "/tmp/test");

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: "openai",
      modelId: "gpt-4o",
    }));

    await flushTaskUpdated();

    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not hot-swap when model fields are unchanged", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const findModel = vi.fn();

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-sonnet-4-5",
      lastTaskModelProvider: "anthropic",
      lastTaskModelId: "claude-sonnet-4-5",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    }));

    await flushTaskUpdated();

    expect(findModel).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("hot-swaps to project default override when task override is cleared", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const findModel = vi.fn().mockReturnValue({
      provider: { name: "openai" },
      id: "gpt-4o",
      name: "GPT-4o",
    });

    store.getSettings.mockResolvedValue({
      executionProvider: undefined,
      executionModelId: undefined,
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-sonnet-4-5",
      lastTaskModelProvider: "anthropic",
      lastTaskModelId: "claude-sonnet-4-5",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: undefined,
      modelId: undefined,
    }));

    await flushTaskUpdated();

    expect(findModel).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(setModel).toHaveBeenCalledTimes(1);
  });

  it("falls back to global default when project default override pair is incomplete", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const findModel = vi.fn().mockReturnValue({
      provider: { name: "anthropic" },
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet",
    });

    store.getSettings.mockResolvedValue({
      executionProvider: undefined,
      executionModelId: undefined,
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      defaultProviderOverride: "openai",
      defaultModelIdOverride: undefined,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "openai",
      lastResolvedModelId: "gpt-4o",
      lastTaskModelProvider: "openai",
      lastTaskModelId: "gpt-4o",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: undefined,
      modelId: undefined,
    }));

    await flushTaskUpdated();

    expect(findModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(setModel).toHaveBeenCalledTimes(1);
  });

  it("logs error and continues when setModel fails", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockRejectedValue(new Error("API key not found"));
    const findModel = vi.fn().mockReturnValue({
      provider: { name: "openai" },
      id: "gpt-4o",
      name: "GPT-4o",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose: vi.fn() },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-sonnet-4-5",
      lastTaskModelProvider: "anthropic",
      lastTaskModelId: "claude-sonnet-4-5",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      modelProvider: "openai",
      modelId: "gpt-4o",
    }));

    await flushTaskUpdated();

    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Model change failed: API key not found", undefined, undefined);
    expect((executor as any).activeSessions.has("FN-001")).toBe(true);
  });

  it("does not attempt hot-swap on paused task", async () => {
    const store = createMockStore();
    const setModel = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();
    const findModel = vi.fn();

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any)._modelRegistry = { find: findModel };
    (executor as any).activeSessions.set("FN-001", {
      session: { setModel, dispose },
      seenSteeringIds: new Set(),
      lastResolvedModelProvider: "anthropic",
      lastResolvedModelId: "claude-sonnet-4-5",
      lastTaskModelProvider: "anthropic",
      lastTaskModelId: "claude-sonnet-4-5",
      lastAssignedAgentId: null,
    });

    store._trigger("task:updated", buildUpdatedTask({
      paused: true,
      modelProvider: "openai",
      modelId: "gpt-4o",
    }));

    await flushTaskUpdated();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(findModel).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("TaskExecutor task:updated listener guards", () => {
  it("catches and logs errors from async task:updated operations", async () => {
    const store = createMockStore();
    const terminateError = new Error("terminate failed");
    const terminateAllSessions = vi.fn().mockRejectedValue(terminateError);

    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).activeStepExecutors.set("FN-001", {
      terminateAllSessions,
    });

    const taskUpdatedHandler = (store.on as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((call: any[]) => call[0] === "task:updated")?.[1];

    expect(taskUpdatedHandler).toBeTypeOf("function");

    await expect(taskUpdatedHandler({
      id: "FN-001",
      title: "Guard test",
      description: "Guard test",
      column: "in-progress",
      paused: true,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies Task)).resolves.toBeUndefined();

    expect(terminateAllSessions).toHaveBeenCalledTimes(1);
    // FN-5256: the pause handler now routes through awaitAbortInFlightTaskWork,
    // which internally catches/logs the per-surface failure. The error still hits
    // executorLog.error but via the granular message path.
    expect(executorLog.error).toHaveBeenCalledWith("Failed to terminate step sessions for FN-001:", terminateError);
  });
});

describe("TaskExecutor global pause behavior", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("disposes all active sessions when settings:updated fires with globalPause: true", async () => {
    const store = createMockStore();
    const disposeFn1 = vi.fn();
    const disposeFn2 = vi.fn();
    let callCount = 0;

    mockedCreateFnAgent.mockImplementation(async () => {
      callCount++;
      const dispose = callCount === 1 ? disposeFn1 : disposeFn2;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Wait for the global pause to fire; only fire once for first task
            if (callCount === 2) {
              store._trigger("settings:updated", {
                settings: { globalPause: true },
                previous: { globalPause: false },
              });
            }
            throw new Error("Session terminated");
          }),
          dispose,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    // Execute two tasks concurrently
    await Promise.all([
      executor.execute({
        id: "FN-001", title: "T1", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      executor.execute({
        id: "FN-002", title: "T2", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ]);

    // Global pause should move both tasks out of in-progress without marking failed.
    expect(store.moveTask).toHaveBeenCalledWith("FN-002", expect.stringMatching(/^(todo|in-review)$/));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", expect.stringMatching(/^(todo|in-review)$/));
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", { status: "failed" });
  });

  it("moves paused tasks to todo (not marked as failed)", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { globalPause: true },
            previous: { globalPause: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("defers completion handoff when global pause hits after fn_task_done", async () => {
    const store = createMockStore();
    let globalPause = false;
    store.getSettings.mockImplementation(async () => ({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: false,
      globalPause,
      enginePaused: false,
    }));

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
      const customTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("tool-1", {});
            }
            globalPause = true;
            store._trigger("settings:updated", {
              settings: { globalPause: true },
              previous: { globalPause: false },
            });
            throw new Error("Session terminated");
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [{ name: "Step 1", status: "pending" }], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(
      store.logEntry.mock.calls.some(
        ([id, action]: [string, string]) =>
          id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
      ),
    ).toBe(true);
  });

  it("parks todo tasks in in-progress when fn_task_done is called during global pause", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];
    let taskDoneResult: any;

    const todoTask = {
      id: "FN-001",
      title: "Test",
      description: "T",
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      column: "todo",
      paused: true,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(todoTask);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
    });
    store.moveTask.mockImplementation(async (_id: string, to: string) => ({ ...todoTask, column: to, paused: undefined }));

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              taskDoneResult = await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");
    await executor.execute(todoTask as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      paused: false,
      pausedByAgentId: null,
      status: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    expect(watchdogSpy).not.toHaveBeenCalledWith("FN-001", "fn_task_done");
    expect(
      store.logEntry.mock.calls.some(
        ([id, action]: [string, string]) =>
          id === "FN-001" && action.includes("fn_task_done called while task was in todo during pause"),
      ),
    ).toBe(true);
    expect(
      store.logEntry.mock.calls.some(
        ([id, action]: [string, string]) =>
          id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
      ),
    ).toBe(true);
    expect(taskDoneResult.content[0].text).toBe(
      "Task marked complete. Completion handoff deferred until pause is cleared.",
    );
  });

  describe("fn_task_done with paused state (FN-3964 / FN-4167 regression)", () => {
    it("advances todo + paused tasks through normal completion handoff", async () => {
      const store = createMockStore();
      let capturedCustomTools: any[] = [];
      let taskDoneResult: any;
      const todoTask = {
        id: "FN-001",
        title: "Paused todo task",
        description: "T",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        column: "todo",
        paused: true,
        pausedByAgentId: "agent-123",
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.getTask.mockResolvedValue(todoTask);
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });
      store.moveTask.mockImplementation(async (_id: string, to: string) => ({ ...todoTask, column: to, paused: false }));

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        capturedCustomTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
              if (taskDoneTool) {
                taskDoneResult = await taskDoneTool.execute("call-1", { summary: "done" });
              }
            }),
            dispose: vi.fn(),
          },
        };
      }) as any);

      const executor = new TaskExecutor(store, "/tmp/test");
      const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");

      await executor.execute(todoTask as any);

      // FN-4145: explicit agent completion always clears task-level pause state.
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        paused: false,
        pausedByAgentId: null,
        status: null,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
      expect(watchdogSpy).toHaveBeenCalledWith("FN-001", "fn_task_done");
      expect(
        store.logEntry.mock.calls.some(
          ([id, action]: [string, string]) =>
            id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
        ),
      ).toBe(false);
      expect(taskDoneResult.content[0].text).toBe(
        "Task marked complete with summary. All steps done. Moving to in-review.",
      );
      // globalPause:true deferred behavior is intentionally covered by the test above.
    });

    it("completes in-progress + paused tasks after clearing task-level pause state", async () => {
      const store = createMockStore();
      let capturedCustomTools: any[] = [];
      let taskDoneResult: any;
      const inProgressTask = {
        id: "FN-001",
        title: "Paused in-progress task",
        description: "T",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        column: "in-progress",
        paused: true,
        pausedByAgentId: "agent-123",
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.getTask.mockResolvedValue(inProgressTask);
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        capturedCustomTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
              if (taskDoneTool) {
                taskDoneResult = await taskDoneTool.execute("call-1", { summary: "done" });
              }
            }),
            dispose: vi.fn(),
          },
        };
      }) as any);

      const executor = new TaskExecutor(store, "/tmp/test");
      const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");

      await executor.execute(inProgressTask as any);

      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        paused: false,
        pausedByAgentId: null,
        status: null,
      });
      expect(watchdogSpy).toHaveBeenCalledWith("FN-001", "fn_task_done");
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-progress");
      expect(
        store.logEntry.mock.calls.some(
          ([id, action]: [string, string]) =>
            id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
        ),
      ).toBe(false);
      expect(taskDoneResult.content[0].text).toBe(
        "Task marked complete with summary. All steps done. Moving to in-review.",
      );
      // globalPause:true deferred behavior is intentionally covered by
      // "parks todo tasks in in-progress when fn_task_done is called during global pause".
    });
  });

  describe("fn_task_done with paused state (FN-3964 / FN-4167 regression)", () => {
    it("advances todo + paused tasks through normal completion handoff", async () => {
      const store = createMockStore();
      let capturedCustomTools: any[] = [];
      const todoTask = {
        id: "FN-001",
        title: "Paused todo task",
        description: "T",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        column: "todo",
        paused: true,
        pausedByAgentId: "agent-123",
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.getTask.mockResolvedValue(todoTask);
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });
      store.moveTask.mockImplementation(async (_id: string, to: string) => ({ ...todoTask, column: to, paused: false }));

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        capturedCustomTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
              if (taskDoneTool) {
                await taskDoneTool.execute("call-1", { summary: "done" });
              }
            }),
            dispose: vi.fn(),
          },
        };
      }) as any);

      const executor = new TaskExecutor(store, "/tmp/test");
      const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");

      await executor.execute(todoTask as any);

      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        paused: false,
        pausedByAgentId: null,
        status: null,
      });
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress");
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
      expect(watchdogSpy).toHaveBeenCalledWith("FN-001", "fn_task_done");
      expect(
        store.logEntry.mock.calls.some(
          ([id, action]: [string, string]) =>
            id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
        ),
      ).toBe(false);
      // globalPause:true deferred behavior is intentionally covered by the test above.
    });

    it("completes in-progress + paused tasks after clearing task-level pause state", async () => {
      const store = createMockStore();
      let capturedCustomTools: any[] = [];
      const inProgressTask = {
        id: "FN-001",
        title: "Paused in-progress task",
        description: "T",
        prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
        column: "in-progress",
        paused: true,
        pausedByAgentId: "agent-123",
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.getTask.mockResolvedValue(inProgressTask);
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        autoMerge: false,
        globalPause: false,
        enginePaused: false,
      });

      mockedCreateFnAgent.mockImplementation((async (opts: any) => {
        capturedCustomTools = opts.customTools || [];
        return {
          session: {
            prompt: vi.fn().mockImplementation(async () => {
              const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
              if (taskDoneTool) {
                await taskDoneTool.execute("call-1", { summary: "done" });
              }
            }),
            dispose: vi.fn(),
          },
        };
      }) as any);

      const executor = new TaskExecutor(store, "/tmp/test");
      const watchdogSpy = vi.spyOn(executor as any, "scheduleCompletedTaskWatchdog");

      await executor.execute(inProgressTask as any);

      expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
        paused: false,
        pausedByAgentId: null,
        status: null,
      });
      expect(watchdogSpy).toHaveBeenCalledWith("FN-001", "fn_task_done");
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-progress");
      expect(
        store.logEntry.mock.calls.some(
          ([id, action]: [string, string]) =>
            id === "FN-001" && action.includes("Completion handoff deferred — global pause active"),
        ),
      ).toBe(false);
      // globalPause:true deferred behavior is intentionally covered by
      // "parks todo tasks in in-progress when fn_task_done is called during global pause".
    });
  });

  it("takes no action when globalPause remains false", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { globalPause: false },
              previous: { globalPause: false },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: disposeFn,
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });

  it("takes no action when globalPause transitions from true to true", async () => {
    const store = createMockStore();
    let capturedCustomTools: any[] = [];

    mockedCreateFnAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            store._trigger("settings:updated", {
              settings: { globalPause: true },
              previous: { globalPause: true },
            });
            const taskDoneTool = capturedCustomTools.find((tool: any) => tool.name === "fn_task_done");
            if (taskDoneTool) {
              await taskDoneTool.execute("call-1", { summary: "done" });
            }
          }),
          dispose: vi.fn(),
        },
      };
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });
});

