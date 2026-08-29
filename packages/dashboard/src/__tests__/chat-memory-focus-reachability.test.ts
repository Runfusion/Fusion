import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, AgentStore, MemorySearchOptions } from "@fusion/core";
import { createChatFusionToolset } from "../chat.js";

/**
 * RUFU-068 production-reachability test.
 *
 * FNXC:ChatMemoryFocusReachability 2026-08-13:
 * This test closes the production-reachability gap flagged in code review: the
 * /focus command and selector persist chat_sessions.memory_focus, but recall is
 * only actually scoped to that topic if the persisted value threads through the
 * dashboard chat toolset into fn_memory_search. It builds the SAME production
 * toolset shape the direct-model-loop (sendMessage) uses — createChatFusionToolset
 * with the session's `focus` derived from memoryFocus — then invokes fn_memory_search
 * and asserts topic reaches the search options handed to searchProjectMemory.
 * The committed core test memory-search-topic.test.ts already proves
 * searchProjectMemory forwards that topic to backend.search() (the SQL
 * enforcement point); this combined chain proves an operator setting /focus
 * actually scopes recall. No live Stash is required.
 *
 * searchProjectMemory is mocked to fingerprint the options the tool passes, so
 * the test never touches a real backend or the network.
 */

const memoryCalls = vi.hoisted(() => {
  const calls: MemorySearchOptions[] = [];
  return {
    calls,
    impl: async (_rootDir: string, options: MemorySearchOptions) => {
      calls.push(options);
      return [
        { path: "/mem.md", lineStart: 1, lineEnd: 2, snippet: "scoped hit", score: 1, backend: "fake" },
      ];
    },
  };
});

// biome-ignore lint/suspicious/noExplicitAny: vi.mock factory re-exports the whole core module (importOriginal) and only replaces the memory-search seam
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    searchProjectMemory: async (rootDir: string, options: MemorySearchOptions, settings: unknown) =>
      memoryCalls.impl(rootDir, options, settings),
  };
});

const baseTaskStore = (settings: Record<string, unknown> = { experimentalFeatures: { chatFocus: true } }) => ({
  getSettings: vi.fn(async () => settings),
} as unknown as TaskStore);

const baseAgentStore = {} as unknown as AgentStore;

async function buildToolset(focus: string | undefined, settings?: Record<string, unknown>) {
  return createChatFusionToolset({
    taskStore: baseTaskStore(settings),
    agentStore: baseAgentStore,
    rootDir: "/project",
    agentId: "agent-abc",
    // The production sendMessage path passes focus: session?.memoryFocus ?? undefined.
    focus,
  });
}

describe("chat memory-focus production reachability (RUFU-068)", () => {
  beforeEach(() => {
    memoryCalls.calls.length = 0;
  });

  it("threads a session memoryFocus topic into fn_memory_search search options", async () => {
    const tools = await buildToolset("stash lcm");
    const searchTool = tools.find((t) => t.name === "fn_memory_search");
    expect(searchTool, "fn_memory_search should be registered with focus present").toBeTruthy();

    const tool = searchTool!;
    const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>;
    await execute("1", { query: "recall target", projectDir: "/project" });

    expect(memoryCalls.calls).toHaveLength(1);
    expect(memoryCalls.calls[0]).toMatchObject({ query: "recall target", topic: "stash lcm" });
  });

  it.each([{}, { experimentalFeatures: { chatFocus: false } }])("keeps persisted focus inert while the flag is off", async (settings) => {
    const tools = await buildToolset("stash lcm", settings);
    const tool = tools.find((candidate) => candidate.name === "fn_memory_search")!;
    await (tool.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>)("1", { query: "recall target", projectDir: "/project" });

    expect(memoryCalls.calls[0]).not.toHaveProperty("topic");
  });

  it("leaves recall whole-project when the session has no focus (undefined -> no topic)", async () => {
    const tools = await buildToolset(undefined);
    const searchTool = tools.find((t) => t.name === "fn_memory_search");
    expect(searchTool, "fn_memory_search should be registered without focus").toBeTruthy();

    const tool = searchTool!;
    const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>;
    await execute("1", { query: "recall target", projectDir: "/project" });

    expect(memoryCalls.calls).toHaveLength(1);
    expect(memoryCalls.calls[0].query).toBe("recall target");
    expect("topic" in memoryCalls.calls[0]).toBe(false);
  });

  it("trims whitespace-trimmable focus before it reaches the search options", async () => {
    const tools = await buildToolset("  space-topic  ");
    const tool = tools.find((t) => t.name === "fn_memory_search")!;
    const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>;
    await execute("1", { query: "x", projectDir: "/project" });

    expect(memoryCalls.calls).toHaveLength(1);
    expect(memoryCalls.calls[0]).toMatchObject({ topic: "space-topic" });
  });

  it("collapses 'all'/'*'/empty focus to whole-project scope (no topic in options)", async () => {
    for (const focus of ["all", "*", "  ", ""]) {
      memoryCalls.calls.length = 0;
      const tools = await buildToolset(focus);
      const tool = tools.find((t) => t.name === "fn_memory_search")!;
      const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<unknown>;
      await execute("1", { query: "x", projectDir: "/project" });
      expect(memoryCalls.calls).toHaveLength(1);
      expect("topic" in memoryCalls.calls[0]).toBe(false);
    }
  });

  it("focus is a within-project read filter — the topic reaches search options and is never reapplied in-memory", async () => {
    // A topic-agnostic backend returns unrelated results too (the committed core
    // test documents this external gap). fn_memory_search must pass those through
    // verbatim — it never re-filters by topic after the backend returns.
    memoryCalls.impl = async (_rootDir: string, options: MemorySearchOptions) => {
      memoryCalls.calls.push(options);
      return [
        { path: "/a.md", lineStart: 1, lineEnd: 2, snippet: "topic hit", score: 2, backend: "fake" },
        { path: "/b.md", lineStart: 1, lineEnd: 2, snippet: "unrelated hit", score: 1, backend: "fake" },
      ];
    };

    const tools = await buildToolset("my-topic");
    const tool = tools.find((t) => t.name === "fn_memory_search")!;
    const result = await (tool.execute as (id: string, params: Record<string, unknown>) => Promise<any>)("1", {
      query: "x",
      projectDir: "/project",
    });

    // Request carried the topic (forwarded to the enforcement point)…
    expect(memoryCalls.calls[0]).toMatchObject({ topic: "my-topic" });
    // …and BOTH backend hits are returned verbatim — no post-query in-memory
    // topic filter was applied client-side.
    const text = String(result?.content?.[0]?.text ?? "");
    expect(text).toContain("topic hit");
    expect(text).toContain("unrelated hit");
  });
});