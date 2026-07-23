import { describe, expect, it, vi } from "vitest";
import type { PlanningQuestion, PlanningResponse } from "@fusion/core";
import {
  createInteractiveAiSessionWith,
  resolvePlanningExecutorSession,
  runCliAgentPlanning,
  type InteractiveAgentFactory,
  type InteractiveAgentResult,
  type InteractiveAgentSession,
} from "../interactive-ai-session.js";
import { interactiveSessionLog } from "../logger.js";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "../agent-runtime.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

function planningRuntime(text: string, options: { throwCreate?: Error; throwPrompt?: Error } = {}) {
  const createOptions: AgentRuntimeOptions[] = [];
  const session = { dispose: vi.fn() } as unknown as AgentSession;
  const runtime: AgentRuntime = {
    id: "acp",
    name: "ACP Runtime",
    async createSession(opts: AgentRuntimeOptions): Promise<AgentSessionResult> {
      createOptions.push(opts);
      if (options.throwCreate) throw options.throwCreate;
      return { session };
    },
    async promptWithFallback(): Promise<void> {
      if (options.throwPrompt) throw options.throwPrompt;
      createOptions[0]?.onText?.(text);
    },
    describeModel() {
      return "acp/test";
    },
  };
  return { runtime, createOptions };
}

describe("runCliAgentPlanning (ACP planning seam)", () => {
  it("maps ACP prose with complete JSON to the SAME PlanningResponse shape a model run produces", async () => {
    const summary = {
      title: "Do X",
      description: "Plan to do X",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: ["X"],
    };
    const { runtime, createOptions } = planningRuntime(`Here is the plan:\n${JSON.stringify({ type: "complete", data: summary })}`);
    const resp: PlanningResponse = await runCliAgentPlanning(runtime, {
      prompt: "plan it",
      cwd: "/tmp",
      settings: { model: "claude-sonnet-4" },
    });
    expect(resp.type).toBe("complete");
    if (resp.type === "complete") expect(resp.data.title).toBe("Do X");
    expect(createOptions[0]).toMatchObject({ tools: "readonly", defaultModelId: "claude-sonnet-4" });
  });

  it("maps ACP prose with question JSON to a PlanningResponse question", async () => {
    const question: PlanningQuestion = { id: "q1", type: "text", question: "What is the goal?" };
    const { runtime } = planningRuntime(`Need input: ${JSON.stringify({ type: "question", data: question })}`);
    const resp = await runCliAgentPlanning(runtime, { prompt: "plan it", cwd: "/tmp" });
    expect(resp.type).toBe("question");
    if (resp.type === "question") expect(resp.data.id).toBe("q1");
  });

  it("throws on a failed ACP ask (never returns a fabricated plan)", async () => {
    const { runtime } = planningRuntime("", { throwPrompt: new Error("transport failed") });
    await expect(runCliAgentPlanning(runtime, { prompt: "plan it", cwd: "/tmp" })).rejects.toThrow(/planning ACP ask failed/i);
  });

  it("throws when ACP prose has no decodable planning JSON", async () => {
    const { runtime } = planningRuntime("no structured answer");
    await expect(runCliAgentPlanning(runtime, { prompt: "plan it", cwd: "/tmp" })).rejects.toThrow(/no valid JSON/i);
  });
});

/**
 * A scripted fake agent: each `prompt()` advances through a queue of canned
 * assistant responses, which are exposed via `state.messages` exactly like the
 * real one-shot agent. This deterministically drives the seam's turn loop
 * without a live model (the accepted integration approach per the plan).
 */
function makeScriptedAgent(responses: string[]): {
  session: InteractiveAgentSession;
  disposed: () => boolean;
  promptCalls: () => string[];
} {
  let index = 0;
  let wasDisposed = false;
  const prompts: string[] = [];
  const messages: InteractiveAgentSession["state"]["messages"] = [];

  const session: InteractiveAgentSession = {
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      const reply = responses[index] ?? responses[responses.length - 1];
      index++;
      messages.push({ role: "assistant", content: reply });
    }),
    state: { messages },
    dispose: vi.fn(() => {
      wasDisposed = true;
    }),
  };

  return { session, disposed: () => wasDisposed, promptCalls: () => prompts };
}

function factoryFor(agent: InteractiveAgentSession): () => Promise<InteractiveAgentResult> {
  return async () => ({ session: agent, sessionFile: "/tmp/fake-session.json" });
}

const q = (data: PlanningQuestion): string => JSON.stringify({ type: "question", data } satisfies PlanningResponse);
const complete = (data: unknown): string => JSON.stringify({ type: "complete", data });

describe("resolvePlanningExecutorSession", () => {
  it("keeps the default model-backed path unchanged", async () => {
    const question: PlanningQuestion = {
      id: "q1",
      type: "text",
      question: "What is the goal?",
    };
    const scripted = makeScriptedAgent([
      q(question),
      complete({ title: "Done", summary: "ok" }),
    ]);
    const factory = vi.fn(factoryFor(scripted.session));

    const { session, sessionFile } = await resolvePlanningExecutorSession({ kind: "model" }, factory, {
      cwd: "/tmp",
      systemPrompt: "emit json protocol",
    });

    expect(sessionFile).toBe("/tmp/fake-session.json");
    expect(factory).toHaveBeenCalledTimes(1);
    await session.prompt("start");
    const ev1 = await session.nextEvent();
    expect(ev1.type).toBe("question");
    expect(ev1.type === "question" && ev1.data.id).toBe("q1");

    await session.answer("q1", "ship it");
    const ev2 = await session.nextEvent();
    expect(ev2.type).toBe("complete");
    expect(ev2.type === "complete" && ev2.data).toEqual({ title: "Done", summary: "ok" });
  });

  it.each([
    ["complete", { type: "complete", data: { title: "Do X", summary: "ok" } } satisfies PlanningResponse],
    ["question", { type: "question", data: { id: "q1", type: "text", question: "What is the goal?" } } satisfies PlanningResponse],
  ])("selects the CLI-agent path for a terminal %s event without using the model factory", async (_name, response) => {
    const { runtime, createOptions } = planningRuntime(`ACP says: ${JSON.stringify(response)}`);
    const modelFactory = vi.fn<InteractiveAgentFactory>(async () => {
      throw new Error("model factory should not be used");
    });

    const { session } = await resolvePlanningExecutorSession({ kind: "cli-agent", runtime }, modelFactory, {
      cwd: "/tmp/project",
      systemPrompt: "emit json protocol",
      defaultModelId: "claude-sonnet-4",
    });

    await session.prompt("plan it");
    const ev = await session.nextEvent();
    expect(modelFactory).not.toHaveBeenCalled();
    expect(createOptions[0]).toMatchObject({
      cwd: "/tmp/project",
      systemPrompt: "emit json protocol",
      tools: "readonly",
      defaultModelId: "claude-sonnet-4",
    });
    expect(ev.type).toBe(response.type);
    expect(ev.type === "question" || ev.type === "complete" ? ev.data : undefined).toEqual(response.data);
    expect(await session.nextEvent()).toBe(ev);

    await session.prompt("ignored after terminal");
    await session.answer("q1", "ignored after terminal");
    expect(await session.nextEvent()).toBe(ev);
  });

  it.each([
    ["unparseable output", () => planningRuntime("no structured answer"), /no valid JSON/i],
    ["failed ACP prompt", () => planningRuntime("", { throwPrompt: new Error("transport failed") }), /planning ACP ask failed/i],
  ])("surfaces malformed/failed CLI-agent output as a terminal error: %s", async (_name, makeRuntime, message) => {
    const { runtime } = makeRuntime();
    const modelFactory = vi.fn<InteractiveAgentFactory>(async () => {
      throw new Error("model factory should not be used");
    });

    const { session } = await resolvePlanningExecutorSession({ kind: "cli-agent", runtime }, modelFactory, {
      cwd: "/tmp",
      systemPrompt: "emit json protocol",
    });

    await session.prompt("plan it");
    const ev = await session.nextEvent();
    expect(modelFactory).not.toHaveBeenCalled();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toMatch(message);
    expect(ev.type).not.toBe("complete");
    expect(ev.type).not.toBe("question");
    expect(await session.nextEvent()).toBe(ev);
  });
});

describe("interactive-ai-session seam", () => {
  it("round-trips question → answer → complete (happy path)", async () => {
    const question: PlanningQuestion = {
      id: "q1",
      type: "text",
      question: "What is the goal?",
    };
    const scripted = makeScriptedAgent([
      q(question),
      complete({ title: "Done", summary: "ok" }),
    ]);

    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "emit json protocol",
    });

    await session.prompt("start");
    const ev1 = await session.nextEvent();
    expect(ev1.type).toBe("question");
    expect(ev1.type === "question" && ev1.data.id).toBe("q1");

    await session.answer("q1", "ship the thing");
    const ev2 = await session.nextEvent();
    expect(ev2.type).toBe("complete");
    expect(ev2.type === "complete" && ev2.data).toEqual({ title: "Done", summary: "ok" });

    // nextEvent stays terminal after complete.
    expect((await session.nextEvent()).type).toBe("complete");

    session.dispose();
    expect(scripted.disposed()).toBe(true);
  });

  it.each([
    ["text", { id: "t", type: "text", question: "Free text?" } as PlanningQuestion, "a free answer"],
    [
      "single_select",
      {
        id: "s",
        type: "single_select",
        question: "Pick one",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      } as PlanningQuestion,
      "a",
    ],
    [
      "multi_select",
      {
        id: "m",
        type: "multi_select",
        question: "Pick many",
        options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }],
      } as PlanningQuestion,
      ["x", "y"],
    ],
    ["confirm", { id: "c", type: "confirm", question: "Sure?" } as PlanningQuestion, true],
  ])("round-trips %s question type", async (_name, question, answer) => {
    const scripted = makeScriptedAgent([q(question), complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("question");
    expect(ev.type === "question" && ev.data.type).toBe(question.type);

    await session.answer(question.id, answer);
    const done = await session.nextEvent();
    expect(done.type).toBe("complete");

    // The structured answer is forwarded to the agent as JSON.
    const lastPrompt = scripted.promptCalls().at(-1)!;
    expect(JSON.parse(lastPrompt)).toMatchObject({ type: "answer", questionId: question.id, response: answer });
  });

  it("retries twice on unparseable output then surfaces an error event (no hang), logging each failed parse", async () => {
    const warnSpy = vi.spyOn(interactiveSessionLog, "warn");
    const errorSpy = vi.spyOn(interactiveSessionLog, "error");
    // First turn: garbage. Both reformat retries: still garbage. → error.
    const scripted = makeScriptedAgent(["not json at all", "still not json", "nope"]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
      defaultProvider: "openai",
      defaultModelId: "gpt-5",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toMatch(/parse/i);

    // Both reformat-retry prompts were actually sent (3 prompts: initial + 2 retries).
    expect(scripted.promptCalls().length).toBe(3);

    // Every failed parse attempt logged a bounded raw-response snippet with the
    // resolved provider/model, and the terminal give-up logged at error level.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0][0]).toContain("provider=openai, model=gpt-5");
    expect(warnSpy.mock.calls[0][0]).toContain('"not json at all"');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("giving up after 3 parse attempts");

    // Terminal: nextEvent keeps returning the error, never hangs.
    expect((await session.nextEvent()).type).toBe("error");
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("flags an empty assistant message distinctly in the parse-failure log", async () => {
    const warnSpy = vi.spyOn(interactiveSessionLog, "warn");
    const scripted = makeScriptedAgent(["", "", ""]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    expect((await session.nextEvent()).type).toBe("error");
    expect(warnSpy.mock.calls[0][0]).toContain("empty assistant message");
    warnSpy.mockRestore();
  });

  it("recovers when the first reformat retry produces valid JSON", async () => {
    const question: PlanningQuestion = { id: "q1", type: "text", question: "?" };
    const scripted = makeScriptedAgent(["garbage", q(question)]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("question");
  });

  it("recovers when only the second reformat retry produces valid JSON", async () => {
    const question: PlanningQuestion = { id: "q1", type: "text", question: "?" };
    const scripted = makeScriptedAgent(["garbage", "still garbage", q(question)]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("question");
    expect(scripted.promptCalls().length).toBe(3);
  });

  it("surfaces agent prompt errors as an error event without throwing", async () => {
    const throwing: InteractiveAgentSession = {
      prompt: vi.fn(async () => {
        throw new Error("transport exploded");
      }),
      state: { messages: [] },
      dispose: vi.fn(),
    };
    const { session } = await createInteractiveAiSessionWith(factoryFor(throwing), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await expect(session.prompt("start")).resolves.toBeUndefined();
    const ev = await session.nextEvent();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toMatch(/transport exploded/);
  });

  it("rejects mismatched question ids by default", async () => {
    const question: PlanningQuestion = { id: "current", type: "text", question: "Current?" };
    const scripted = makeScriptedAgent([q(question), complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    expect((await session.nextEvent()).type).toBe("question");

    await session.answer("persisted", "answer");
    const ev = await session.nextEvent();
    expect(ev.type).toBe("error");
    expect(ev.type === "error" && ev.data.message).toContain('questionId "persisted" does not match current question "current"');
    expect(scripted.promptCalls()).toHaveLength(1);
  });

  it("can trust the caller's persisted question id after non-deterministic rehydration", async () => {
    const question: PlanningQuestion = { id: "rehydrated-different", type: "text", question: "Rehydrated?" };
    const scripted = makeScriptedAgent([q(question), complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
      allowAnswerQuestionIdDrift: true,
    });

    await session.prompt("start");
    expect((await session.nextEvent()).type).toBe("question");

    await session.answer("persisted-original", "answer");
    const done = await session.nextEvent();
    expect(done.type).toBe("complete");
    const lastPrompt = scripted.promptCalls().at(-1)!;
    expect(JSON.parse(lastPrompt)).toMatchObject({
      type: "answer",
      questionId: "persisted-original",
      response: "answer",
    });
  });

  it("ignores answer() when not awaiting input", async () => {
    const scripted = makeScriptedAgent([complete({ ok: true })]);
    const { session } = await createInteractiveAiSessionWith(factoryFor(scripted.session), {
      cwd: "/tmp",
      systemPrompt: "protocol",
    });

    await session.prompt("start");
    expect((await session.nextEvent()).type).toBe("complete");

    // answer() after terminal is a no-op; nextEvent stays complete.
    await session.answer("whatever", "x");
    expect((await session.nextEvent()).type).toBe("complete");
  });
});
