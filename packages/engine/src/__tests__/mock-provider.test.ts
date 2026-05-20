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
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { accumulateSessionTokenUsage } from "../session-token-usage.js";
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
    ["triage", ["write", "fn_review_spec"]],
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
    const reviewSpecExecute = vi.fn(async () => {
      toolCalls.push("fn_review_spec");
      return { content: [{ type: "text", text: "APPROVE" }], details: {} };
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
        createTool("fn_review_spec", reviewSpecExecute),
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
    expect(store.updateTask).toHaveBeenCalledWith(taskId, {
      tokenUsage: expect.objectContaining({
        inputTokens: MOCK_SYNTHETIC_TOKEN_USAGE.input,
        outputTokens: MOCK_SYNTHETIC_TOKEN_USAGE.output,
        cachedTokens: MOCK_SYNTHETIC_TOKEN_USAGE.cacheRead,
        cacheWriteTokens: MOCK_SYNTHETIC_TOKEN_USAGE.cacheWrite,
      }),
    });
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
          createTool("fn_review_spec"),
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
    for (const forbidden of ["node:http", "node:https", "undici", "node-fetch", "@mariozechner/pi-ai"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(MOCK_PROVIDER_ID).toBe("mock");
  });
});
