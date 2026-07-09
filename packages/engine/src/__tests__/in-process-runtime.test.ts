import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { CliSession } from "@fusion/core";
import {
  buildCliAgentAwaitingInputNotificationPayload,
  InProcessRuntime,
} from "../runtimes/in-process-runtime.js";

describe("InProcessRuntime onStart duplicate guard", () => {
  it("contains a taskAgentMap guard before creating task-worker agents", () => {
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("if (this.taskAgentMap.has(task.id))");
    expect(source).toContain("Skipping task-worker creation for");
  });

  it("exposes getChatStore and wires HeartbeatMonitor to the runtime chatStore instance", () => {
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("this.chatStore ??= new ChatStore(this.taskStore.getFusionDir(), this.taskStore.getDatabase());");
    expect(source).toContain("chatStore: this.chatStore,");
    expect(source).toContain("getChatStore(): import(\"@fusion/core\").ChatStore | undefined {");
    expect(source).toContain("return this.chatStore;");
  });

  it("wires heartbeat worktree-acquisition retry-cap exhaustion into CentralCore failure stats (FN-7721)", () => {
    // FN-7721: a heartbeat-driven task worktree acquisition that exhausts its
    // bounded cross-heartbeat retry cap must be counted the same way
    // `Executor`'s `onError` counts a failure, so
    // `performanceSummary.totalTasksFailed` / project health stats are not
    // silently starved of a real failure.
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("onTaskAcquisitionExhausted: (taskId, detail) => {");
    expect(source).toContain("this.recordTaskCompletion(taskId, false);");
  });

  it("rehydrates autopilot mission watches during startup recovery", () => {
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("activeMissionAutopilot.recoverMissions(activeMissionStore)");
  });

  it("builds prompt-scoped CLI input notification dedupe keys", () => {
    const makeSession = (updatedAt: string): CliSession => ({
      id: "cli-1",
      taskId: "FN-7109",
      chatSessionId: null,
      purpose: "execute",
      projectId: "proj-test",
      adapterId: "claude-code",
      agentState: "waitingOnInput",
      terminationReason: null,
      nativeSessionId: null,
      resumeAttempts: 0,
      autonomyPosture: null,
      worktreePath: null,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt,
    });

    const first = buildCliAgentAwaitingInputNotificationPayload({
      projectId: "proj-test",
      info: {
        sessionId: "cli-1",
        notification: { kind: "permission_request", toolName: "Bash", prompt: "run tests" },
      },
      session: makeSession("2026-06-27T00:01:00.000Z"),
      task: undefined,
    });
    const duplicate = buildCliAgentAwaitingInputNotificationPayload({
      projectId: "proj-test",
      info: {
        sessionId: "cli-1",
        notification: { prompt: "run tests", toolName: "Bash", kind: "permission_request" },
      },
      session: makeSession("2026-06-27T00:01:00.000Z"),
      task: undefined,
    });
    const nextPromptSameSession = buildCliAgentAwaitingInputNotificationPayload({
      projectId: "proj-test",
      info: {
        sessionId: "cli-1",
        notification: { kind: "permission_request", toolName: "Bash", prompt: "run build" },
      },
      session: makeSession("2026-06-27T00:02:00.000Z"),
      task: undefined,
    });

    expect(first.metadata?.notificationDedupeKey).toBe(duplicate.metadata?.notificationDedupeKey);
    expect(nextPromptSameSession.metadata?.notificationDedupeKey).not.toBe(first.metadata?.notificationDedupeKey);
  });

  it("forwards task:deleted events with and without githubIssueAction metadata", () => {
    const runtime = new InProcessRuntime(
      {
        projectId: "proj-test",
        workingDirectory: process.cwd(),
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      },
      {
        getGlobalConcurrencyState: vi.fn(),
        recordTaskCompletion: vi.fn(),
      } as any,
    );

    const taskStore = new EventEmitter();
    const emitSpy = vi.spyOn(runtime, "emit");
    (runtime as any).taskStore = taskStore;
    (runtime as any).setupEventForwarding();

    const task = { id: "FN-1", title: "task" };
    const meta = { githubIssueAction: "auto" };

    taskStore.emit("task:deleted", task, meta);
    taskStore.emit("task:deleted", task);

    expect(emitSpy).toHaveBeenCalledWith("task:deleted", task, meta);
    expect(emitSpy).toHaveBeenCalledWith("task:deleted", task, undefined);
  });
});
