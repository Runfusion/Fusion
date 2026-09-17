/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 AI task search service behaviour. These assertions exist because every one of them is a way
 * the feature can silently degrade into something that LOOKS like it works:
 *  - ranking by date before selecting would return the five newest tasks, not the five best;
 *  - accepting ids outside the candidate set would let a model invent tasks;
 *  - concatenating per-query results would discard every expansion;
 *  - a silent runtime-default model would make the operator's Fast & Cheap setting a lie.
 * No real model, provider SDK, or network call is reachable from this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  AI_TASK_SEARCH_ERROR_CODES,
  AI_TASK_SEARCH_MAX_CANDIDATES,
  AI_TASK_SEARCH_MAX_CONTEXT_CHARS,
  AI_TASK_SEARCH_MAX_REQUESTS_PER_HOUR,
} from "../shared/task-search.js";
import {
  AiTaskSearchError,
  __resetAiTaskSearchStateForTests,
  checkAiTaskSearchRateLimit,
  composeCandidateSet,
  extractJsonObject,
  orderSelectionByRecency,
  searchTasksWithAi,
  serializeCandidates,
  type AiTaskSearchSessionHandle,
} from "../ai-task-search.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title ${overrides.id}`,
    description: overrides.description ?? "",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    column: "todo",
    ...overrides,
  } as Task;
}

interface StoreStubOptions {
  settings?: Record<string, unknown>;
  corpus?: Record<string, Task[]>;
  tasksById?: Record<string, Task | null>;
  onGetTask?: (id: string) => void;
}

function makeStore(options: StoreStubOptions = {}) {
  const searchCalls: string[] = [];
  const getTaskCalls: string[] = [];
  const store = {
    getRootDir: () => "/tmp/project-a",
    getSettings: async () => options.settings ?? { fastCheapProvider: "anthropic", fastCheapModelId: "fast-1" },
    searchTasks: async (query: string) => {
      searchCalls.push(query);
      return options.corpus?.[query] ?? [];
    },
    getTask: async (id: string) => {
      getTaskCalls.push(id);
      options.onGetTask?.(id);
      if (options.tasksById && id in options.tasksById) {
        const row = options.tasksById[id];
        if (!row) throw new Error("not found");
        return row;
      }
      return makeTask({ id });
    },
  };
  return { store: store as never, searchCalls, getTaskCalls };
}

/** Scripted session: one reply per prompt call, in order. */
function makeScriptedDeps(replies: string[], hooks: {
  onCreate?: (options: unknown) => void;
  createDelayMs?: number;
  createRejects?: boolean;
  promptRejects?: Error;
  disposeSpy?: () => void;
} = {}) {
  const prompts: string[] = [];
  let index = 0;
  let text = "";
  const handle: AiTaskSearchSessionHandle = {
    session: {},
    readText: () => text,
    resetText: () => { text = ""; },
    dispose: () => hooks.disposeSpy?.(),
  };
  return {
    prompts,
    deps: {
      createSession: async (createOptions: unknown) => {
        hooks.onCreate?.(createOptions);
        if (hooks.createDelayMs) await new Promise((resolve) => setTimeout(resolve, hooks.createDelayMs));
        if (hooks.createRejects) throw new Error("runtime refused");
        return handle;
      },
      prompt: async (_handle: AiTaskSearchSessionHandle, message: string) => {
        prompts.push(message);
        if (hooks.promptRejects) throw hooks.promptRejects;
        text = replies[index] ?? "";
        index += 1;
      },
    },
  };
}

beforeEach(() => {
  __resetAiTaskSearchStateForTests();
});

describe("extractJsonObject", () => {
  it("reads a bare object, a fenced object, and an object wrapped in prose", () => {
    expect(extractJsonObject('{"taskIds":["FN-1"]}')).toEqual({ taskIds: ["FN-1"] });
    expect(extractJsonObject('```json\n{"taskIds":["FN-2"]}\n```')).toEqual({ taskIds: ["FN-2"] });
    expect(extractJsonObject('Here you go: {"taskIds":["FN-3"]} hope that helps'))
      .toEqual({ taskIds: ["FN-3"] });
  });

  it("is not confused by braces inside strings and returns undefined for unusable text", () => {
    expect(extractJsonObject('{"taskIds":["FN-{4}"]}')).toEqual({ taskIds: ["FN-{4}"] });
    expect(extractJsonObject("no json at all")).toBeUndefined();
    expect(extractJsonObject("{ not valid json")).toBeUndefined();
  });
});

describe("composeCandidateSet", () => {
  it("preserves every source query instead of letting the first one consume the budget", () => {
    const first = Array.from({ length: 60 }, (_unused, index) => makeTask({ id: `A-${index}` }));
    const second = Array.from({ length: 60 }, (_unused, index) => makeTask({ id: `B-${index}` }));
    const composed = composeCandidateSet([first, second]);
    expect(composed).toHaveLength(AI_TASK_SEARCH_MAX_CANDIDATES);
    expect(composed.some((task) => task.id.startsWith("A-"))).toBe(true);
    expect(composed.some((task) => task.id.startsWith("B-"))).toBe(true);
  });

  it("deduplicates by canonical id across queries", () => {
    const composed = composeCandidateSet([
      [makeTask({ id: "FN-1" }), makeTask({ id: "FN-2" })],
      [makeTask({ id: "fn-1" }), makeTask({ id: "FN-3" })],
    ]);
    // `fn-1` is the same task as `FN-1`, so it is absorbed rather than occupying a second slot.
    expect(composed.map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });
});

describe("serializeCandidates", () => {
  it("keeps the ESCAPED payload inside the budget by shrinking descriptions first", () => {
    const candidates = Array.from({ length: 100 }, (_unused, index) => makeTask({
      id: `FN-${index}`,
      title: `Task ${index}`,
      description: '"quoted" '.repeat(400),
    }));
    const serialized = serializeCandidates(candidates);
    expect(serialized.length).toBeLessThanOrEqual(AI_TASK_SEARCH_MAX_CONTEXT_CHARS);
    const parsed = JSON.parse(serialized) as { id: string }[];
    // Breadth is preserved: every candidate still has an identifiable row.
    expect(parsed).toHaveLength(100);
  });

  it("never sends fields beyond id, title, bounded description, and date", () => {
    const serialized = serializeCandidates([makeTask({
      id: "FN-1",
      description: "visible",
      // Fields that must never leave the server.
      prompt: "SECRET PROMPT",
      activityLog: [{ message: "SECRET LOG" }],
    } as never)]);
    expect(serialized).toContain("visible");
    expect(serialized).not.toContain("SECRET PROMPT");
    expect(serialized).not.toContain("SECRET LOG");
    expect(Object.keys(JSON.parse(serialized)[0]).sort()).toEqual(["createdAt", "description", "id", "title"]);
  });
});

describe("orderSelectionByRecency", () => {
  it("sorts newest first with a stable id tiebreak and invalid dates last", () => {
    const ordered = orderSelectionByRecency([
      makeTask({ id: "FN-2", createdAt: "2026-02-01T00:00:00.000Z" }),
      makeTask({ id: "FN-9", createdAt: "not-a-date" }),
      makeTask({ id: "FN-1", createdAt: "2026-03-01T00:00:00.000Z" }),
      makeTask({ id: "FN-3", createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3", "FN-9"]);
  });
});

describe("searchTasksWithAi", () => {
  it("finds the exact requested title from a paraphrase that never contains the literal word", async () => {
    const target = makeTask({
      id: "FN-331",
      title: "le bouton collapse du leftsidebar doit être au header de la sidebar et être du meme design que le bouton qui collapse la rightsidebar.",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const { store, searchCalls } = makeStore({
      corpus: {
        "replier le panneau lateral": [],
        collapse: [target],
        sidebar: [makeTask({ id: "FN-700" })],
      },
    });
    const { deps, prompts } = makeScriptedDeps([
      '{"queries":["collapse","sidebar"]}',
      '{"taskIds":["FN-331"]}',
    ]);

    const results = await searchTasksWithAi({
      store,
      query: "replier le panneau lateral",
      projectKey: "p1",
      deps,
    });

    // The corpus read used the ORIGINAL query plus its expansions, not the browser's collection.
    expect(searchCalls).toEqual(["replier le panneau lateral", "collapse", "sidebar"]);
    expect(prompts).toHaveLength(2);
    expect(results.map((task) => task.id)).toEqual(["FN-331"]);
  });

  it("keeps the model's relevance choice and only then orders it newest-first", async () => {
    // Six relevant candidates plus one NEWER decoy the model does not choose.
    const corpusRows = [
      makeTask({ id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-2", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeTask({ id: "FN-3", createdAt: "2026-01-03T00:00:00.000Z" }),
      makeTask({ id: "FN-4", createdAt: "2026-01-04T00:00:00.000Z" }),
      makeTask({ id: "FN-5", createdAt: "2026-01-05T00:00:00.000Z" }),
      makeTask({ id: "FN-6", createdAt: "2026-01-06T00:00:00.000Z" }),
      makeTask({ id: "FN-DECOY", createdAt: "2026-12-31T00:00:00.000Z" }),
    ];
    const tasksById = Object.fromEntries(corpusRows.map((task) => [task.id, task]));
    const { store } = makeStore({ corpus: { collapse: corpusRows }, tasksById });
    const { deps } = makeScriptedDeps([
      '{"queries":[]}',
      // Relevance order, deliberately not date order, and deliberately excluding the newer decoy.
      '{"taskIds":["FN-3","FN-1","FN-5","FN-2","FN-4"]}',
    ]);

    const results = await searchTasksWithAi({ store, query: "collapse", projectKey: "p1", deps });

    // Same five the model chose — the decoy never enters despite being the newest task.
    expect(new Set(results.map((task) => task.id))).toEqual(new Set(["FN-1", "FN-2", "FN-3", "FN-4", "FN-5"]));
    // ...ordered newest-first.
    expect(results.map((task) => task.id)).toEqual(["FN-5", "FN-4", "FN-3", "FN-2", "FN-1"]);
  });

  it("returns zero, three, and exactly five results without padding", async () => {
    const rows = Array.from({ length: 8 }, (_unused, index) => makeTask({
      id: `FN-${index}`,
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    }));
    const tasksById = Object.fromEntries(rows.map((task) => [task.id, task]));

    const empty = await searchTasksWithAi({
      store: makeStore({ corpus: {} }).store,
      query: "nothing",
      projectKey: "p1",
      deps: makeScriptedDeps(['{"queries":[]}', '{"taskIds":[]}']).deps,
    });
    expect(empty).toEqual([]);

    const three = await searchTasksWithAi({
      store: makeStore({ corpus: { q: rows }, tasksById }).store,
      query: "q",
      projectKey: "p1",
      deps: makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-0","FN-1","FN-2"]}']).deps,
    });
    expect(three).toHaveLength(3);

    const five = await searchTasksWithAi({
      store: makeStore({ corpus: { q: rows }, tasksById }).store,
      query: "q",
      projectKey: "p1",
      deps: makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-0","FN-1","FN-2","FN-3","FN-4","FN-5","FN-6"]}']).deps,
    });
    expect(five).toHaveLength(5);
  });

  it("deduplicates repeated ids and drops ids outside the candidate set", async () => {
    const rows = [makeTask({ id: "FN-1" }), makeTask({ id: "FN-2" })];
    const { store } = makeStore({ corpus: { q: rows }, tasksById: { "FN-1": rows[0], "FN-2": rows[1] } });
    const { deps } = makeScriptedDeps([
      '{"queries":[]}',
      '{"taskIds":["FN-1","FN-1","FN-2","FN-OTHER-PROJECT"]}',
    ]);
    const results = await searchTasksWithAi({ store, query: "q", projectKey: "p1", deps });
    expect(results.map((task) => task.id).sort()).toEqual(["FN-1", "FN-2"]);
  });

  it("treats an all-foreign id list and malformed JSON as errors, never as no results", async () => {
    const rows = [makeTask({ id: "FN-1" })];
    const foreignOnly = searchTasksWithAi({
      store: makeStore({ corpus: { q: rows } }).store,
      query: "q",
      projectKey: "p1",
      deps: makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-NOT-A-CANDIDATE"]}']).deps,
    });
    await expect(foreignOnly).rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.invalidModelResponse });

    const malformed = searchTasksWithAi({
      store: makeStore({ corpus: { q: rows } }).store,
      query: "q",
      projectKey: "p1",
      deps: makeScriptedDeps(['{"queries":[]}', "I could not decide."]).deps,
    });
    await expect(malformed).rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.invalidModelResponse });
  });

  it("drops a task deleted during the prompt instead of returning a dead row", async () => {
    const rows = [makeTask({ id: "FN-1" }), makeTask({ id: "FN-2" })];
    const { store } = makeStore({
      corpus: { q: rows },
      tasksById: { "FN-1": null, "FN-2": rows[1] },
    });
    const { deps } = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1","FN-2"]}']);
    const results = await searchTasksWithAi({ store, query: "q", projectKey: "p1", deps });
    expect(results.map((task) => task.id)).toEqual(["FN-2"]);
  });

  it("uses the project Fast & Cheap pair, its credential instance, and its thinking level", async () => {
    const created: Record<string, unknown>[] = [];
    const { store } = makeStore({
      settings: {
        fastCheapProvider: "anthropic",
        fastCheapModelId: "haiku-fast",
        fastCheapCredentialInstanceId: "cred-7",
        fastCheapThinkingLevel: "low",
      },
      corpus: { q: [makeTask({ id: "FN-1" })] },
    });
    const { deps } = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}'], {
      onCreate: (options) => created.push(options as Record<string, unknown>),
    });
    await searchTasksWithAi({ store, query: "q", projectKey: "p1", deps });
    expect(created[0]).toMatchObject({
      provider: "anthropic",
      modelId: "haiku-fast",
      credentialInstanceId: "cred-7",
      thinkingLevel: "low",
    });
  });

  it("falls back to the GLOBAL Fast & Cheap pair when the project pair is partial", async () => {
    const created: Record<string, unknown>[] = [];
    const { store } = makeStore({
      settings: {
        // Partial project pair — must not be used.
        fastCheapProvider: "anthropic",
        fastCheapGlobalProvider: "openai",
        fastCheapGlobalModelId: "mini",
      },
      corpus: { q: [makeTask({ id: "FN-1" })] },
    });
    const { deps } = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}'], {
      onCreate: (options) => created.push(options as Record<string, unknown>),
    });
    await searchTasksWithAi({ store, query: "q", projectKey: "p1", deps });
    expect(created[0]).toMatchObject({ provider: "openai", modelId: "mini" });
  });

  it("routes testMode through the same factory with the mock provider and no real call", async () => {
    const created: Record<string, unknown>[] = [];
    const { store } = makeStore({
      settings: { testMode: true, fastCheapProvider: "anthropic", fastCheapModelId: "haiku" },
      corpus: { q: [makeTask({ id: "FN-1" })] },
    });
    const { deps } = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}'], {
      onCreate: (options) => created.push(options as Record<string, unknown>),
    });
    await searchTasksWithAi({ store, query: "q", projectKey: "p1", deps });
    expect(created[0].provider).toBe("mock");
  });

  it("errors explicitly rather than silently using the runtime default when no pair resolves", async () => {
    const { store } = makeStore({ settings: {} });
    const { deps } = makeScriptedDeps([]);
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps }))
      .rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.unavailable });
  });

  it("maps a refused runtime to the unavailable code", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] } });
    const { deps } = makeScriptedDeps([], { createRejects: true });
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps }))
      .rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.unavailable });
  });

  it("aborts before creating a session when the client already disconnected", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] } });
    let createCalls = 0;
    const { deps } = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}'], {
      onCreate: () => { createCalls += 1; },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", signal: controller.signal, deps }))
      .rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.timeout });
    expect(createCalls).toBe(0);
  });

  it("disposes a session that finishes constructing after cancellation and never prompts it", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] } });
    const disposeSpy = vi.fn();
    const controller = new AbortController();
    // Cancel WHILE the runtime is constructing the session, so the handle is delivered to a request
    // that has already unwound. That is the ordering that leaks a live session if it is unhandled.
    const { deps, prompts } = makeScriptedDeps(['{"queries":[]}'], {
      createDelayMs: 20,
      disposeSpy,
      onCreate: () => controller.abort(),
    });
    const pending = searchTasksWithAi({ store, query: "q", projectKey: "p1", signal: controller.signal, deps });
    await expect(pending).rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.timeout });
    expect(prompts).toHaveLength(0);
    // Teardown is bounded but genuinely asynchronous: the runtime hands the session back AFTER the
    // caller has already been rejected, and the service must still dispose it rather than leak it.
    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalled());
  });

  it("tolerates a disposer that throws and still releases capacity for the next request", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] }, tasksById: { "FN-1": makeTask({ id: "FN-1" }) } });
    const throwing = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}'], {
      disposeSpy: () => { throw new Error("teardown exploded"); },
    });
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: throwing.deps })).resolves.toHaveLength(1);

    // Capacity was released despite the throwing disposer: a second search still runs.
    const second = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}']);
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: second.deps })).resolves.toHaveLength(1);
  });

  it("recovers capacity after a failed search so an error is not a permanent lockout", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] }, tasksById: { "FN-1": makeTask({ id: "FN-1" }) } });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const failing = makeScriptedDeps([], { createRejects: true });
      await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: failing.deps })).rejects.toBeInstanceOf(AiTaskSearchError);
    }
    const ok = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}']);
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: ok.deps })).resolves.toHaveLength(1);
  });

  it("caps concurrent searches per project without consuming a task-execution slot", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] }, tasksById: { "FN-1": makeTask({ id: "FN-1" }) } });
    const gate: (() => void)[] = [];
    const slowDeps = () => ({
      createSession: async () => ({
        session: {},
        readText: () => '{"queries":[]}',
        resetText: () => undefined,
        dispose: () => undefined,
      }),
      // Blocks until the test releases it, then fails the turn so the search unwinds deterministically.
      prompt: () => new Promise<void>((_resolve, reject) => {
        gate.push(() => reject(new Error("released")));
      }),
    });

    const first = searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: slowDeps() }).catch(() => "failed");
    const second = searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: slowDeps() }).catch(() => "failed");
    await vi.waitFor(() => expect(gate.length).toBe(2));

    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: slowDeps() }))
      .rejects.toMatchObject({ code: AI_TASK_SEARCH_ERROR_CODES.rateLimited });

    for (const release of gate) release();
    await expect(Promise.all([first, second])).resolves.toEqual(["failed", "failed"]);

    // Capacity is returned once both in-flight searches unwind.
    const recovered = makeScriptedDeps(['{"queries":[]}', '{"taskIds":["FN-1"]}']);
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps: recovered.deps })).resolves.toHaveLength(1);
  });

  it("refuses the request after the dedicated hourly budget is spent", () => {
    for (let call = 0; call < AI_TASK_SEARCH_MAX_REQUESTS_PER_HOUR; call += 1) {
      expect(checkAiTaskSearchRateLimit("p1", "1.2.3.4")).toBe(true);
    }
    expect(checkAiTaskSearchRateLimit("p1", "1.2.3.4")).toBe(false);
    // A different project and a different IP keep their own budgets.
    expect(checkAiTaskSearchRateLimit("p2", "1.2.3.4")).toBe(true);
    expect(checkAiTaskSearchRateLimit("p1", "5.6.7.8")).toBe(true);
  });

  it("surfaces a prompt rejection as a bounded service error with no unhandled rejection", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] } });
    const { deps } = makeScriptedDeps([], { promptRejects: new Error("provider exploded") });
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps }))
      .rejects.toBeInstanceOf(AiTaskSearchError);
  });

  it("never leaks provider prose into the thrown error message", async () => {
    const { store } = makeStore({ corpus: { q: [makeTask({ id: "FN-1" })] } });
    const { deps } = makeScriptedDeps([], {
      promptRejects: new Error("api key sk-secret-value rejected by upstream"),
    });
    await expect(searchTasksWithAi({ store, query: "q", projectKey: "p1", deps }))
      .rejects.toSatisfy((err: Error) => !err.message.includes("sk-secret-value"));
  });
});
