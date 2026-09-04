import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  resolvePreMergeGateForTask: vi.fn(),
  getTaskMergeBlocker: vi.fn(),
}));
const reviewer = vi.hoisted(() => ({ create: vi.fn() }));
const mergeContent = vi.hoisted(() => ({ capture: vi.fn() }));
const reroute = vi.hoisted(() => ({ route: vi.fn() }));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  ...core,
}));
vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-session-helpers.js")>()),
  createResolvedAgentSession: reviewer.create,
}));
vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: mergeContent.capture }));
vi.mock("../merge/stale-content-review-reroute.js", () => ({ rerouteSingularStaleContentToReview: reroute.route }));

import { ProjectEngine } from "../project-engine.js";
import { executeWorkflowStep } from "../executor/execute-workflow-step.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
type SinkMode = "absent" | "throws" | "rejects" | "pending" | "late-resolve" | "late-reject";

async function git(cwd: string, args: string[]) {
  return await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), "fusion-review-audit-"));
  directories.push(directory);
  await git(directory, ["init"]);
  await git(directory, ["config", "user.email", "test@example.test"]);
  await git(directory, ["config", "user.name", "Test"]);
  await writeFile(join(directory, "app.txt"), "base\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "base"]);
  const base = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(directory, "app.txt"), "implementation\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "implementation"]);
  return { directory, base, reviewed: (await git(directory, ["rev-parse", "HEAD"])).stdout.trim() };
}

function hostileSink(mode: SinkMode) {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const started = Promise.withResolvers<void>();
  const recordRunAuditEvent = mode === "absent" ? undefined : vi.fn(() => {
    started.resolve();
    if (mode === "throws") throw new Error("audit unavailable");
    if (mode === "rejects") return Promise.reject(new Error("audit unavailable"));
    if (mode === "pending") return new Promise<void>(() => undefined);
    return new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  });
  return { recordRunAuditEvent, started: started.promise, settle: () => resolve?.(), reject: () => reject?.(new Error("late audit failure")) };
}

async function throughBoundedAudit<T>(mode: SinkMode, sink: ReturnType<typeof hostileSink>, run: () => Promise<T>) {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  if (mode === "pending" || mode.startsWith("late-")) vi.useFakeTimers();
  try {
    const pending = run();
    if (mode === "pending" || mode.startsWith("late-")) {
      await sink.started;
      await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    }
    const result = await pending;
    if (mode === "late-resolve") sink.settle();
    if (mode === "late-reject") sink.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
    return result;
  } finally {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  }
}

/**
 * FNXC:RunAudit 2026-09-01-12:40:
 * FN-9234 audit coverage invokes the review producer and merge-gate owner rather than the bounded
 * helper directly. A hostile telemetry sink must not alter an approval's returned identity or the
 * stale-content reroute decision, including when it settles after the bounded wait.
 */
afterEach(async () => {
  vi.useRealTimers();
  reviewer.create.mockReset();
  core.resolvePreMergeGateForTask.mockReset();
  core.getTaskMergeBlocker.mockReset();
  mergeContent.capture.mockReset();
  reroute.route.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FN-9234 review-recapture audit sink health", () => {
  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("keeps review-input recapture effective with a %s audit sink", async (mode) => {
    const repo = await createRepository();
    const sink = hostileSink(mode);
    reviewer.create.mockImplementation(async () => {
      const listeners: Array<(event: any) => void> = [];
      return { session: {
        state: {}, subscribe: (listener: (event: any) => void) => { listeners.push(listener); return () => undefined; },
        prompt: vi.fn(async () => {
          await writeFile(join(repo.directory, "review-fix.txt"), "fixed\n");
          await git(repo.directory, ["add", "."]);
          await git(repo.directory, ["commit", "-m", "review fix"]);
          const output = JSON.stringify({ verdict: "APPROVE", notes: "Re-reviewed after inline fix." });
          listeners.forEach((listener) => listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: output, partial: output } }));
        }), dispose: vi.fn(),
      } };
    });
    const task = { id: "FN-9234", title: "Audit", description: "Audit", baseCommitSha: repo.base, steps: [], currentStep: 0, log: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" } as any;
    const store = {
      getTask: vi.fn(async () => task), logEntry: vi.fn(async () => undefined), appendAgentLog: vi.fn(async () => undefined), isBackendMode: () => false,
      ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}),
    } as any;
    const outcome = await throughBoundedAudit(mode, sink, () => executeWorkflowStep({
      store, rootDir: repo.directory, options: {}, activePlanningWorkflowSessions: new Set(), activeWorkflowStepSessions: new Map(),
      getRunContextFor: () => ({ agentId: "reviewer", runId: "audit-run" }), captureModifiedFiles: async () => [],
      createSpawnAgentTool: () => undefined, sharedWorkerTools: {}, deleteActiveWorkflowStepSession: () => undefined,
      getAssignedAgentRuntimeConfig: () => undefined, getAuthoritativeAssignedAgent: async () => undefined,
      readTaskArtifact: async () => "# Task", resolveInstructionsForRole: async () => "", resolveMcpServers: async () => [], setActiveWorkflowStepSession: () => undefined,
    } as any, task, {
      id: "code-review", name: "Code Review", description: "Review", mode: "prompt", phase: "pre-merge", gateMode: "gate", prompt: "Review", toolMode: "readonly", enabled: true, optionalGroupId: "code-review", reviewKind: "code",
    } as any, repo.directory, {}));
    expect(outcome).toMatchObject({ success: true, verdict: "APPROVE", reviewedCommitSha: await git(repo.directory, ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim()) });
  });

  it.each(["absent", "throws", "rejects", "pending", "late-resolve", "late-reject"] as const)("keeps stale-content reroute effective with a %s audit sink", async (mode) => {
    const sink = hostileSink(mode);
    const task = { id: "FN-9234", column: "in-review", steps: [], workflowStepResults: [], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" } as any;
    core.resolvePreMergeGateForTask.mockResolvedValue({ provenance: "selected", selectionAbsent: false, reviewColumns: new Set(["in-review"]), requiredPreMergeStepIds: new Set(["code-review"]) });
    core.getTaskMergeBlocker.mockReturnValue("task has a pre-merge approval recorded against different content");
    mergeContent.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } });
    reroute.route.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "code-review", workflowStepId: "code-review" });
    const store = { logEntry: vi.fn(async () => undefined), ...(sink.recordRunAuditEvent ? { recordRunAuditEvent: sink.recordRunAuditEvent } : {}) } as any;
    const engine = new ProjectEngine({ projectId: "audit", workingDirectory: process.cwd(), isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 } as any, {} as any, { skipNotifier: true });
    const result = await throughBoundedAudit(mode, sink, () => (engine as any).resolveMergeGateBlocker(store, task, {}));
    expect(result).toBe("task has a pre-merge approval recorded against different content");
    expect(reroute.route).toHaveBeenCalledTimes(1);
  });
});
