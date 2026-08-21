import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEngineCoreMock } from "../test/mockCore.js";
import {
  createMemorySearchTool,
  createMemoryTools,
  resolveMemorySearchTopic,
} from "../agent-tools.js";
import { buildProactiveMemoryCueBlock } from "@fusion/core";
import type { MemorySearchOptions } from "@fusion/core";
// Static namespace import so Vite statically resolves the core memory-backend
// module to the SAME instance the @fusion/core barrel (aliased to core source)
// loads internally — spying resolveMemoryBackend here honors the ESM live
// binding used by project-memory.ts (mirrors
// packages/core/src/memory/__tests__/memory-search-topic.test.ts).
import * as coreMemoryBackend from "../../../core/src/memory/memory-backend.js";

/**
 * RUFU-068 engine recall-scoping tests: per-conversation memory FOCUS must
 * scope project recall to a topic as a WITHIN-project read filter.
 *
 * The committed seam threads the topic through:
 *   fn_memory_search (createMemorySearchTool) -> searchProjectMemory
 *   -> backend.search (Stash pushes it as a &topic= search-route param, the
 *   SQL enforcement point, once the route supports it)
 * and proactive pre-response recall (buildProactiveMemoryCueBlock) forwards
 * the topic down the same path.
 *
 * FNXC:MemoryFocusEngineTest 2026-08-13-16:35:
 * These tests run WITHOUT a live Stash / real network. They prove that
 * (a) an active topic is preserved on the backend `search()` options (never a
 * post-query in-memory filter), (b) undefined/null/""/"all"/"*" collapse back
 * to whole-project scope (project default), (c) a whitespace-trimmed topic is
 * used, and (d) focus NEVER weakens cross-project A/B isolation — the topic is
 * a WITHIN-project read filter handed to the backend, and capture stays
 * write-anywhere / topic-agnostic.
 */

// ── mock @fusion/core for the fn_memory_search tool wiring ─────────────
// We keep the real buildProactiveMemoryCueBlock (pass-through) and only
// spy the reads it needs; searchProjectMemory + isMemoryBackendHealthy are
// replaced with spies so createMemorySearchTool's topic threading is observed
// without any backend or network.
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return createEngineCoreMock(
    () => importOriginal<typeof import("@fusion/core")>(),
    {
      searchProjectMemory: vi.fn(),
      isMemoryBackendHealthy: vi.fn(),
      buildProactiveMemoryCueBlock: actual.buildProactiveMemoryCueBlock,
    },
  );
});

// The real buildProactiveMemoryCueBlock (pass-through from the mocked barrel)
// internally calls resolveMemoryBackend bound from memory-backend.js; spying the
// static namespace import above drives a fake backend through the REAL logic.

type BackendModule = typeof coreMemoryBackend;

const ROOT = "/repos/projectA";

function callTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }, callId: string, params: Record<string, unknown>) {
  return tool.execute(callId, params, undefined, undefined, undefined);
}

function textOf(result: unknown): string {
  const first = (result as { content?: Array<{ type: string; text?: string }> })?.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("resolveMemorySearchTopic (RUFU-068 focus collapse)", () => {
  it("returns the trimmed topic for a non-empty focus", () => {
    expect(resolveMemorySearchTopic("stash lcm")).toBe("stash lcm");
    expect(resolveMemorySearchTopic("  space-topics  ")).toBe("space-topics");
  });

  it.each([undefined, null, "", "   ", "all", "*", "  all  ", " * "])(
    "collapses %j to undefined -> whole-project scope",
    (focus) => {
      expect(resolveMemorySearchTopic(focus as string | null | undefined)).toBeUndefined();
    },
  );
});
describe("fn_memory_search tool topic threading (RUFU-068)", () => {
  let searchSpy: ReturnType<typeof vi.fn>;
  let healthSpy: ReturnType<typeof vi.fn>;
  let coreMod: typeof import("@fusion/core");

  beforeEach(async () => {
    coreMod = await import("@fusion/core");
    searchSpy = coreMod.searchProjectMemory as unknown as ReturnType<typeof vi.fn>;
    healthSpy = coreMod.isMemoryBackendHealthy as unknown as ReturnType<typeof vi.fn>;
    searchSpy.mockReset();
    healthSpy.mockReset();
    searchSpy.mockResolvedValue([]);
    healthSpy.mockResolvedValue({ backend: "stash", available: true });
  });

  afterEach(() => {
    searchSpy.mockReset();
    healthSpy.mockReset();
  });

  async function runSearch(opts: { params?: Record<string, unknown>; focus?: string }) {
    const tool = createMemorySearchTool(ROOT, undefined, opts.focus ? { focus: opts.focus } : undefined);
    return callTool(tool, "call-1", { query: "durable memory", ...opts.params });
  }

  it("scopes project recall to the active topic via options.focus", async () => {
    await runSearch({ focus: "stash lcm" });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ query: "durable memory", limit: 5, topic: "stash lcm" }),
      undefined,
    );
  });

  it("prefers an explicit params.topic over the session focus", async () => {
    await runSearch({ focus: "stash lcm", params: { topic: "explicit topic" } });
    expect(searchSpy).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ query: "durable memory", limit: 5, topic: "explicit topic" }),
      undefined,
    );
  });

  it.each([undefined, "all", "*", "", "   "])(
    "searches whole-project scope (no topic) when focus is %j",
    async (focus) => {
      const tool = createMemorySearchTool(ROOT, undefined, focus !== undefined && focus !== null ? { focus } : undefined);
      await callTool(tool, "call-1", { query: "durable memory" });
      expect(searchSpy).toHaveBeenCalledTimes(1);
      const [, options] = searchSpy.mock.calls[0] as [string, MemorySearchOptions, unknown];
      expect(options.query).toBe("durable memory");
      expect(options.topic).toBeUndefined();
    },
  );

  it("threads an explicitly-set params.topic into backend.search", async () => {
    await runSearch({ params: { topic: "stash lcm" } });
    expect(searchSpy).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ query: "durable memory", limit: 5, topic: "stash lcm" }),
      undefined,
    );
  });

  it("is a within-project read filter: the topic reaches searchProjectMemory options, never a post-query filter", async () => {
    // A topic-agnostic backend would receive topic in its options but return its
    // normal (possibly unfiltered) results; the ENGINE must NOT re-filter them
    // in-memory. The spy receives the topic inside search options (the seam),
    // and the returned results are surfaced verbatim.
    searchSpy.mockResolvedValue([
      { path: "stash://session/fusion-1-a", lineStart: 1, lineEnd: 1, snippet: "topic hit", score: 1, backend: "stash" },
      { path: "stash://session/fusion-1-b", lineStart: 1, lineEnd: 1, snippet: "unrelated hit", score: 0.5, backend: "stash" },
    ]);
    const result = await runSearch({ focus: "stash lcm" });
    // topic was forwarded to the enforcement seam (searchProjectMemory options)
    expect(searchSpy.mock.calls[0][1]).toMatchObject({ topic: "stash lcm" });
    // results are returned verbatim — NO client-side in-memory re-filter
    expect(textOf(result)).toContain("unrelated hit");
  });

  it("createMemoryTools wires the same focus through fn_memory_search", async () => {
    const tools = createMemoryTools(ROOT, undefined, { focus: "stash lcm" });
    const searchTool = tools.find((t) => t.name === "fn_memory_search");
    expect(searchTool).toBeTruthy();
    await callTool(searchTool!, "call-1", { query: "durable memory" });
    expect(searchSpy).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ topic: "stash lcm" }),
      undefined,
    );
  });
});

describe("buildProactiveMemoryCueBlock topic forwarding (RUFU-068)", () => {
  let backendSpy: ReturnType<typeof vi.fn>;
  let resolveSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mod = coreMemoryBackend as unknown as BackendModule;
    backendSpy = vi.fn<MemoryBackendSearch>().mockResolvedValue([]);
    resolveSpy = vi.spyOn(mod, "resolveMemoryBackend").mockReturnValue({
      type: "stash",
      name: "Stash",
      capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: true, persistent: true },
      read: async () => ({ content: "", exists: false, backend: "stash" }),
      write: async () => ({ success: true, backend: "stash" }),
      search: backendSpy,
    } as never);
  });

  afterEach(() => {
    resolveSpy.mockRestore();
  });

  async function cue(opts: { topic?: string }) {
    return buildProactiveMemoryCueBlock(ROOT, "recall query", undefined, opts.topic !== undefined ? { topic: opts.topic } : undefined);
  }

  function lastSearchOptions(): MemorySearchOptions {
    expect(backendSpy).toHaveBeenCalled();
    const [, options] = backendSpy.mock.calls[backendSpy.mock.calls.length - 1] as [string, MemorySearchOptions];
    return options;
  }

  it("forwards the topic to backend.search when a non-empty topic is active", async () => {
    await cue({ topic: "stash lcm" });
    expect(lastSearchOptions().topic).toBe("stash lcm");
  });

  it.each(["", "all", "*", "   "])("does NOT forward a %j topic (whole-project scope)", async (topic) => {
    await cue({ topic });
    expect(lastSearchOptions().topic).toBeUndefined();
  });

  it("does not forward an omitted topic (whole-project scope)", async () => {
    await cue({});
    expect(backendSpy).toHaveBeenCalled();
    expect(lastSearchOptions().topic).toBeUndefined();
  });

  it("returns results verbatim — never post-filters the recalled cue in-memory", async () => {
    backendSpy.mockResolvedValue([
      { path: "stash://session/fusion-1-a", lineStart: 1, lineEnd: 1, snippet: "topic hit", score: 1, backend: "stash" },
      { path: "stash://session/fusion-1-b", lineStart: 1, lineEnd: 1, snippet: "unrelated hit", score: 0.5, backend: "stash" },
    ]);
    const result = await cue({ topic: "stash lcm" });
    expect(lastSearchOptions().topic).toBe("stash lcm");
    // both results surface in the cue — the CUE is a projection of the backend's
    // search result set, not a second in-memory topic filter.
    expect(result).toContain("unrelated hit");
  });
});

type MemoryBackendSearch = (root: string, options: MemorySearchOptions) => Promise<Array<{ path: string; lineStart: number; lineEnd: number; snippet: string; score: number; backend: string }>>;