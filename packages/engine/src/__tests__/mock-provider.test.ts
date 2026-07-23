import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn(),
}));

vi.mock("node:http", () => ({
  request: httpRequestMock,
}));

vi.mock("node:https", () => ({
  request: httpsRequestMock,
}));

import * as http from "node:http";
import * as https from "node:https";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { accumulateSessionTokenUsage } from "../execution/session-token-usage.js";
import {
  MOCK_PROVIDER_ID,
  MOCK_SYNTHETIC_TOKEN_USAGE,
  MockAgentRuntime,
  clearMockScript,
  resetMockScripts,
  setMockScript,
} from "../providers/mock-provider.js";

function createTool(name: string, execute = vi.fn().mockResolvedValue({ content: [], details: {} })): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object" } as never,
    execute,
  } as unknown as ToolDefinition;
}

async function createWorkspace(taskId = "FN-5203") {
  const root = await mkdtemp(join(tmpdir(), "fn-mock-provider-"));
  const cwd = join(root, ".worktrees", "test-mode");
  await mkdir(cwd, { recursive: true });
  const taskDir = join(root, ".fusion", "tasks", taskId);
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, "task.json"), JSON.stringify({ id: taskId, steps: [{ status: "todo" }, { status: "done" }, { status: "todo" }] }), "utf8");
  return { root, cwd, taskDir, taskId };
}

describe("MockAgentRuntime", () => {
  beforeEach(() => {
    resetMockScripts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetMockScripts();
  });

  it.each([
    ["executor", ["fn_task_show", "fn_task_update", "fn_task_update"]],
    ["triage", ["write"]],
    ["reviewer", []],
    ["merger", []],
    ["heartbeat", []],
    ["validation", []],
  ] as const)("runs the default %s script deterministically", async (sessionPurpose, expectedCalls) => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskDir, taskId } = await createWorkspace();
    const toolCalls: string[] = [];
    const writeExecute = vi.fn(async (_id, args) => {
      await writeFile(String((args as { path: string }).path), String((args as { content: string }).content), "utf8");
      toolCalls.push("write");
      return { content: [], details: {} };
    });
    const updateExecute = vi.fn(async (_id, args) => {
      toolCalls.push("fn_task_update");
      return { content: [{ type: "text", text: JSON.stringify(args) }], details: {} };
    });
    const taskShowExecute = vi.fn(async () => {
      toolCalls.push("fn_task_show");
      return { steps: [{ status: "todo" }, { status: "done" }, { status: "todo" }] };
    });
    const onText = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose },
      customTools: [
        createTool("write", writeExecute),
        createTool("fn_task_show", taskShowExecute),
        createTool("fn_task_update", updateExecute),
      ],
      onText,
      onToolStart,
      onToolEnd,
      taskId,
      taskTitle: "Mock task",
    });

    await runtime.promptWithFallback(session, "run it");

    expect(runtime.describeModel(session)).toBe("mock/scripted");
    expect((session as any).state).toEqual({});
    expect((session as any).getSessionStats()).toEqual({ tokens: MOCK_SYNTHETIC_TOKEN_USAGE });
    expect(toolCalls).toEqual(expectedCalls);
    expect(onToolStart.mock.calls.map(([name]) => name)).toEqual(expectedCalls);
    expect(onToolEnd.mock.calls.map(([name]) => name)).toEqual(expectedCalls);

    if (sessionPurpose === "executor") {
      expect(taskShowExecute).toHaveBeenCalledTimes(1);
    }
    if (sessionPurpose === "triage") {
      const promptText = await readFile(join(taskDir, "PROMPT.md"), "utf8");
      expect(promptText).toContain("## Mission");
    }
    if (sessionPurpose === "reviewer" || sessionPurpose === "validation") {
      expect(onText).toHaveBeenCalledWith(expect.stringContaining("Verdict: APPROVE"));
    }
  });

  it("prefers a task-scoped override over the default script", async () => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskId } = await createWorkspace("FN-9999");
    const updateExecute = vi.fn();
    const override = vi.fn(async (ctx) => {
      await ctx.invokeTool("fn_task_update", { step: 7, status: "done" });
    });
    setMockScript({ sessionPurpose: "executor", taskId }, { run: override });

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose: "executor" },
      customTools: [createTool("fn_task_update", updateExecute)],
      taskId,
    });

    await runtime.promptWithFallback(session, "override");
    expect(override).toHaveBeenCalled();
    expect(updateExecute).toHaveBeenCalledWith(expect.any(String), { step: 7, status: "done" }, undefined, undefined, expect.anything());

    clearMockScript({ sessionPurpose: "executor", taskId });
    updateExecute.mockClear();
    await runtime.promptWithFallback(session, "default");
    expect(updateExecute).toHaveBeenCalledWith(expect.any(String), { step: 1, status: "done" }, undefined, undefined, expect.anything());
  });

  it("treats graph-owned executor step sessions as successful without lifecycle tools", async () => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskId } = await createWorkspace("FN-7228");
    const onText = vi.fn();
    const taskShowExecute = vi.fn();

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose: "executor" },
      customTools: [createTool("fn_task_show", taskShowExecute)],
      onText,
      taskId,
    });

    await expect(runtime.promptWithFallback(session, "run graph-owned step")).resolves.toBeUndefined();
    expect(taskShowExecute).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith(expect.stringContaining("graph-owned step session"));
  });

  it("emits mock text through session subscription events for workflow-step parsers", async () => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskId } = await createWorkspace("FN-7228-SUBSCRIBE");
    const deltas: string[] = [];

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose: "reviewer" },
      taskId,
    });
    (session as any).subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        deltas.push(event.assistantMessageEvent.delta);
      }
    });

    await runtime.promptWithFallback(session, "review");
    expect(deltas.join("")).toContain("Verdict: APPROVE");
  });

  it("emits an approval verdict for executor-backed workflow steps without lifecycle tools", async () => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskId } = await createWorkspace("FN-7228-WORKFLOW-STEP");
    const deltas: string[] = [];

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose: "executor" },
      taskId,
    });
    (session as any).subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        deltas.push(event.assistantMessageEvent.delta);
      }
    });

    await runtime.promptWithFallback(session, "Execute the workflow step \"Code Review\" for task FN-7228-WORKFLOW-STEP.");
    expect(deltas.join("")).toContain("\"verdict\":\"APPROVE\"");
  });

  it("accumulates synthetic token usage once per session baseline", async () => {
    const runtime = new MockAgentRuntime();
    const { cwd, taskId } = await createWorkspace();
    const store = {
      getTask: vi.fn().mockResolvedValue({ tokenUsage: undefined }),
      updateTask: vi.fn(),
    };

    const { session } = await runtime.createSession({
      cwd,
      systemPrompt: "system",
      runtimeContext: { sessionPurpose: "heartbeat" },
      taskId,
    });

    await accumulateSessionTokenUsage(store as never, taskId, session);
    await accumulateSessionTokenUsage(store as never, taskId, session);

    expect(store.updateTask).toHaveBeenCalledTimes(1);
    /*
    FNXC:MockProvider 2026-07-16-08:10:
    accumulateSessionTokenUsage may pass a third options/context argument (undefined
    here). Match on the task id + tokenUsage fields rather than exact arity so the
    synthetic baseline contract stays stable.
    */
    expect(store.updateTask).toHaveBeenCalledWith(
      taskId,
      {
        tokenUsage: expect.objectContaining({
          inputTokens: MOCK_SYNTHETIC_TOKEN_USAGE.input,
          outputTokens: MOCK_SYNTHETIC_TOKEN_USAGE.output,
          cachedTokens: MOCK_SYNTHETIC_TOKEN_USAGE.cacheRead,
          cacheWriteTokens: MOCK_SYNTHETIC_TOKEN_USAGE.cacheWrite,
        }),
      },
      undefined,
    );
  });

  it("never makes network calls and does not import network SDKs", async () => {
    const runtime = new MockAgentRuntime();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    httpRequestMock.mockImplementation(() => {
      throw new Error("http.request should not be called");
    });
    httpsRequestMock.mockImplementation(() => {
      throw new Error("https.request should not be called");
    });

    for (const sessionPurpose of ["executor", "triage", "reviewer", "merger", "heartbeat", "validation"] as const) {
      const { cwd, taskId } = await createWorkspace(`FN-${sessionPurpose}`);
      const { session } = await runtime.createSession({
        cwd,
        systemPrompt: "system",
        runtimeContext: { sessionPurpose },
        customTools: [
          createTool("write", vi.fn(async (_id, args) => {
            await writeFile(String((args as { path: string }).path), String((args as { content: string }).content), "utf8");
            return { content: [], details: {} };
          })),
          createTool("fn_task_update"),
          createTool("fn_task_show"),
        ],
        taskId,
      });
      await runtime.promptWithFallback(session, "network guard");
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(http.request).toBe(httpRequestMock);
    expect(https.request).toBe(httpsRequestMock);
    expect(httpRequestMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();

    if (originalFetch) {
      vi.stubGlobal("fetch", originalFetch);
    } else {
      vi.unstubAllGlobals();
    }

    const source = await readFile(new URL("../providers/mock-provider.ts", import.meta.url), "utf8");
    for (const forbidden of ["node:http", "node:https", "undici", "node-fetch", "@earendil-works/pi-ai"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(MOCK_PROVIDER_ID).toBe("mock");
  });
});
