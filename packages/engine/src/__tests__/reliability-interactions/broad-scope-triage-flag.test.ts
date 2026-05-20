import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, TaskStore } from "@fusion/core";

import * as broadScopeHeuristics from "../../triage-broad-scope-heuristics.js";
import { TriageProcessor } from "../../triage.js";

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "fusion-broad-scope-triage-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  git(rootDir, "git commit --allow-empty -m init");

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  await store.updateSettings({ ...DEFAULT_SETTINGS, requirePlanApproval: false });
  const triage = new TriageProcessor(store, rootDir);

  return {
    rootDir,
    store,
    triage,
    persistPrompt: async (taskId: string, prompt: string) => {
      await mkdir(join(rootDir, ".fusion", "tasks", taskId), { recursive: true });
      await writeFile(join(rootDir, ".fusion", "tasks", taskId, "PROMPT.md"), prompt, "utf-8");
    },
    cleanup: async () => {
      store.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

function buildPrompt({ size, stepCount, fileScopeCount }: { size: "S" | "M" | "L"; stepCount: number; fileScopeCount: number }): string {
  const steps = Array.from({ length: stepCount }, (_, index) => `### Step ${index + 1}: Step ${index + 1}\n- [ ] do work ${index + 1}`)
    .join("\n\n");
  const fileScope = Array.from({ length: fileScopeCount }, (_, index) => `- ` + "`" + `packages/engine/src/generated/file-${index + 1}.ts` + "`")
    .join("\n");

  return `# Task: FN-1 - test\n\n**Size:** ${size}\n\n## Review Level: 1\n\n## File Scope\n${fileScope}\n\n## Steps\n\n${steps}\n`;
}

describe("reliability interactions: broad-scope triage flag", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (fixtures.length) await fixtures.pop()!.cleanup();
  });

  it("adds broadScopeFlag metadata and preserves intentSignature/fileScope composition", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Repair engine regression across generated files",
      description: "Touches /api/tasks/:id/pr/options, auth.ts, and 30 failing files across the triage pipeline.",
    });
    const prompt = buildPrompt({ size: "L", stepCount: 12, fileScopeCount: 25 });
    await fx.persistPrompt(task.id, prompt);

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(task.id);
    expect(updated.sourceMetadata?.broadScopeFlag).toMatchObject({
      score: 9,
      reasons: expect.arrayContaining(["size-l", "steps-high", "file-scope-high", "failing-file-mentions-high", "size-l-with-many-steps"]),
      signals: expect.objectContaining({
        size: "L",
        stepCount: 12,
        fileScopeCount: 25,
        failingFileMentions: 30,
      }),
      thresholds: expect.objectContaining({
        stepsHigh: 12,
        fileScopeHigh: 20,
        failingFileMentionsHigh: 30,
        sizeLStepsThreshold: 9,
      }),
      version: 1,
      flaggedAt: expect.any(String),
    });
    expect(updated.sourceMetadata?.intentSignature).toBeTruthy();
    expect(updated.sourceMetadata?.fileScope).toHaveLength(25);
  });

  it("keeps flagged tasks in todo because the flag is advisory only", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Repair engine regression across generated files",
      description: "Touches /api/tasks/:id/pr/options, auth.ts, and 30 failing files across the triage pipeline.",
    });
    const prompt = buildPrompt({ size: "L", stepCount: 12, fileScopeCount: 25 });
    await fx.persistPrompt(task.id, prompt);

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("todo");
  });

  it("emits a run-audit event with the broad-scope metadata payload", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Repair engine regression across generated files",
      description: "Touches /api/tasks/:id/pr/options, auth.ts, and 30 failing files across the triage pipeline.",
    });
    const prompt = buildPrompt({ size: "L", stepCount: 12, fileScopeCount: 25 });
    await fx.persistPrompt(task.id, prompt);

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const audit = fx.store.getRunAuditEvents({ taskId: task.id, limit: 20 });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mutationType: "task:broad-scope-flagged-at-triage",
        metadata: expect.objectContaining({
          score: 9,
          reasons: expect.arrayContaining(["size-l", "steps-high", "file-scope-high", "failing-file-mentions-high", "size-l-with-many-steps"]),
          signals: expect.objectContaining({ size: "L", stepCount: 12, fileScopeCount: 25, failingFileMentions: 30 }),
          thresholds: expect.objectContaining({
            stepsHigh: 12,
            fileScopeHigh: 20,
            failingFileMentionsHigh: 30,
            sizeLStepsThreshold: 9,
          }),
          version: 1,
        }),
      }),
    ]));
  });

  it("appends an operator log entry when the flag fires", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Repair engine regression across generated files",
      description: "Touches /api/tasks/:id/pr/options, auth.ts, and 30 failing files across the triage pipeline.",
    });
    const prompt = buildPrompt({ size: "L", stepCount: 12, fileScopeCount: 25 });
    await fx.persistPrompt(task.id, prompt);

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(task.id);
    expect(updated.log.some((entry) => entry.action === "Broad-scope triage flag")).toBe(true);
  });

  it("does not add flag metadata, audit, or log entry for small narrow tasks", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Fix one narrow regression",
      description: "Touches auth.ts only.",
    });
    const prompt = buildPrompt({ size: "S", stepCount: 4, fileScopeCount: 3 });
    await fx.persistPrompt(task.id, prompt);

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.sourceMetadata?.broadScopeFlag).toBeUndefined();
    expect(updated.log.some((entry) => entry.action === "Broad-scope triage flag")).toBe(false);
    const audit = fx.store.getRunAuditEvents({ taskId: task.id, limit: 20 });
    expect(audit.some((entry) => entry.mutationType === "task:broad-scope-flagged-at-triage")).toBe(false);
  });

  it("fails open when signal extraction throws", async () => {
    const fx = await createFixture();
    fixtures.push(fx);

    const task = await fx.store.createTask({
      title: "Repair engine regression across generated files",
      description: "Touches /api/tasks/:id/pr/options, auth.ts, and 30 failing files across the triage pipeline.",
    });
    const prompt = buildPrompt({ size: "L", stepCount: 12, fileScopeCount: 25 });
    await fx.persistPrompt(task.id, prompt);
    vi.spyOn(broadScopeHeuristics, "extractBroadScopeSignals").mockImplementation(() => {
      throw new Error("boom");
    });

    await (fx.triage as any).finalizeApprovedTask(task, prompt, await fx.store.getSettings(), {});

    const updated = await fx.store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.sourceMetadata?.broadScopeFlag).toBeUndefined();
    expect(updated.log.some((entry) => entry.action === "Broad-scope triage flag")).toBe(false);
    const audit = fx.store.getRunAuditEvents({ taskId: task.id, limit: 20 });
    expect(audit.some((entry) => entry.mutationType === "task:broad-scope-flagged-at-triage")).toBe(false);
  });
});
