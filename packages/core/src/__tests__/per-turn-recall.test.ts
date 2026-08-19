import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  buildPerTurnMemoryRecallCue,
  deriveRecallKeywords,
  __resetPerTurnRecallDedupForTests,
  PER_TURN_RECALL_CUE_MAX_CHARS,
  PER_TURN_RECALL_DEDUP_MAX_SESSIONS,
  PER_TURN_RECALL_DEDUP_MAX_SIGNATURES,
  type PerTurnRecallOptions,
} from "../memory/recall/per-turn-recall.js";
import { MEMORY_PRE_STEERING_MARKER } from "../memory/memory-pre-steering.js";
import {
  registerMemoryBackend,
  type MemoryBackend,
  type MemorySearchResult,
} from "../memory/memory-backend.js";
import type { Settings } from "../types/settings/settings-scope.js";

/*
FNXC:PerTurnMemoryRecall 2026-08-18-22:35:
RUFU-120 B.2 symptom-verification tests for the per-turn recall core (per-turn-recall.ts).
All cases run against in-memory fake backends with UNIQUE type names (perturn-fake,
perturn-fake-nosearch, perturn-fake-reject) to avoid cross-file registry pollution, mirroring
the fake pattern of memory-backend.test.ts. No real Stash/qmd process is spawned.

2026-08-18-22:35:
The original test file was lost when the azure-frost worktree was removed with
uncommitted content (engine worktree re-home onto opal-creek during a dependency-content
import). This file is a faithful re-implementation of the same test contract: the
Symptom Verification assertions (marker cue on first prompt; no re-injection on the second
turn), the full silent-skip surface enumeration, client-side score filtering, the 800-char
whole-entry budget, top-K clamping, and the bounded session-scoped dedup registry.
*/

const ROOT = "/tmp/perturn-recall-fake-project";
const TOPIC = "čo sme diskutovali o LCM B.1 B.2";

function makeSettings(overrides: Partial<Settings> = {}): Partial<Settings> {
  return {
    memoryEnabled: true,
    memoryBackendType: "perturn-fake",
    memoryPerTurnRecallEnabled: true,
    memoryPerTurnRecallTopK: 3,
    ...overrides,
  };
}

function makeHit(path: string, lineStart: number, lineEnd: number, snippet: string, score: number): MemorySearchResult {
  return { path, lineStart, lineEnd, snippet, score, backend: "perturn-fake" };
}

// Mutable per-test state for the score-filter fake.
let fakeHits: MemorySearchResult[] = [];
let searchCalls: Array<{ query: string; limit?: number }> = [];

beforeAll(() => {
  const baseCapabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };
  const read: MemoryBackend["read"] = async () => ({ content: "", exists: false, backend: "perturn-fake" });
  const write: MemoryBackend["write"] = async () => {
    throw new Error("read-only fake");
  };

  registerMemoryBackend({
    type: "perturn-fake",
    name: "Per-turn recall fake backend",
    capabilities: baseCapabilities,
    read,
    write,
    search: async (_rootDir, opts) => {
      searchCalls.push(opts);
      return fakeHits;
    },
  });
  registerMemoryBackend({
    type: "perturn-fake-nosearch",
    name: "Per-turn recall fake backend (no search)",
    capabilities: baseCapabilities,
    read,
    write,
  });
  registerMemoryBackend({
    type: "perturn-fake-reject",
    name: "Per-turn recall fake backend (rejecting search)",
    capabilities: baseCapabilities,
    read,
    write,
    search: async () => {
      throw new Error("backend search exploded");
    },
  });
});

beforeEach(() => {
  fakeHits = [];
  searchCalls = [];
  __resetPerTurnRecallDedupForTests();
});

function call(topic: string, opts: Partial<PerTurnRecallOptions> = {}): Promise<string> {
  return buildPerTurnMemoryRecallCue({
    rootDir: ROOT,
    topic,
    sessionKey: opts.sessionKey ?? "chat:test-session",
    settings: opts.settings ?? makeSettings(),
    topK: opts.topK,
  });
}

function entryLines(cue: string): string[] {
  return cue.split("\n").filter((line) => /^\d+\. `/.test(line));
}

// ── Symptom Verification (B.2: recall on the first prompt; dedup on the second turn) ──

describe("Symptom Verification: per-turn recall on the current topic", () => {
  it("injects a marker-tagged, snippet-bearing cue on the first prompt (recognition gap is gone)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const cue = await call(TOPIC);
    expect(cue).not.toBe("");
    // Original symptom assertion 1: the injected prompt contains the recall cue.
    expect(cue).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(cue).toContain("docs/research/volt-lcm-analysis.md:12-18");
    expect(cue).toContain("B.2 LCM per-turn recall");
    expect(cue).toContain("Use fn_memory_get");
  });

  it("does not re-inject the identical cue on the second turn (session-scoped dedup)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const first = await call(TOPIC);
    expect(first).not.toBe("");
    const second = await call(TOPIC);
    // Original symptom assertion 2: second identical prompt has no repeated cue.
    expect(second).toBe("");
  });

  it("does re-inject for a different session (dedup is session-scoped, not global)", async () => {
    fakeHits = [makeHit("docs/research/volt-lcm-analysis.md", 12, 18, "B.2 LCM per-turn recall — priorita: plan", 0.9)];
    const first = await call(TOPIC, { sessionKey: "chat:session-a" });
    expect(first).not.toBe("");
    const other = await call(TOPIC, { sessionKey: "chat:session-b" });
    expect(other).not.toBe("");
    expect(other).toBe(first);
  });
});

// ── Requirement 6: short AND-reliable Stash query (no multi-word full-sentence query) ──

describe("deriveRecallKeywords (Stash AND-semantics guard)", () => {
  it("drops sub-3-char tokens and stopwords, keeping 2-3 content keywords", () => {
    // "LCM B.1 B.2 priorita plan" failed against Stash (0 events) because of AND-matching;
    // the derived query keeps only surviving content terms.
    const keywords = deriveRecallKeywords(TOPIC);
    expect(keywords).toEqual(["diskutovali", "lcm"]);
  });

  it("drops English and Slovak stopwords and ranks by length descending", () => {
    const keywords = deriveRecallKeywords("What did we do about the memory backend refactor?");
    expect(keywords).toEqual(["refactor", "backend", "memory"]);
  });

  it("returns [] for empty and stopword-only topics", () => {
    expect(deriveRecallKeywords("")).toEqual([]);
    expect(deriveRecallKeywords("   ")).toEqual([]);
    expect(deriveRecallKeywords("čo sme na sú ako")).toEqual([]);
  });

  it("caps at 3 keywords, deduped, keeping the longest content terms", () => {
    const keywords = deriveRecallKeywords("alpha beta gamma delta epsilon zeta");
    expect(keywords.length).toBeLessThanOrEqual(3);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it("truncates each term at 24 chars", () => {
    const keywords = deriveRecallKeywords("a".repeat(40));
    expect(keywords).toEqual(["a".repeat(24)]);
  });

  it("caps the joined query at 64 chars by dropping trailing keywords", () => {
    const keywords = deriveRecallKeywords(
      "abcdefghijklmnopqrstuvwx yzabcdefghijklmnopqrstuvwx abcdefghijklmnopqrstuvwx",
    );
    expect(keywords.join(" ").length).toBeLessThanOrEqual(64);
    expect(keywords.length).toBe(2);
  });
});

describe("query construction against the backend", () => {
  it("sends the short joined keyword query with 3x topK limit headroom", async () => {
    fakeHits = [makeHit("m.md", 1, 2, "snippet", 0.5)];
    await call(TOPIC);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].query).toBe("diskutovali lcm");
    expect(searchCalls[0].limit).toBe(9); // 3 * topK(3), below the 20 cap
  });
});

// ── Silent-skip contract (surface enumeration: every data state) ──

describe("silent skip contract", () => {
  it("returns '' and makes NO backend call when memoryPerTurnRecallEnabled is false", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryPerTurnRecallEnabled: false }) });
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' and makes NO backend call when memoryEnabled is false (project memory off)", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryEnabled: false }) });
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' and makes NO backend call for a stopword-only topic", async () => {
    const cue = await call("čo sme na sú ako");
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(0);
  });

  it("returns '' when the backend has no search capability", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryBackendType: "perturn-fake-nosearch" }) });
    expect(cue).toBe("");
  });

  it("returns '' when backend.search rejects", async () => {
    const cue = await call(TOPIC, { settings: makeSettings({ memoryBackendType: "perturn-fake-reject" }) });
    expect(cue).toBe("");
  });

  it("returns '' for an unregistered backend type (resolver fallback cannot serve the cue)", async () => {
    const cue = await call(TOPIC, {
      settings: makeSettings({ memoryBackendType: "perturn-definitely-not-registered-xyz" }),
    });
    expect(cue).toBe("");
  });

  it("returns '' when the search yields no hits", async () => {
    fakeHits = [];
    const cue = await call(TOPIC);
    expect(cue).toBe("");
    expect(searchCalls).toHaveLength(1);
  });
});

// ── Client-side score filtering (Stash has no server-side score filter) ──

describe("client-side score filtering and top-K", () => {
  it("keeps only positive-score hits, sorted by score descending (default topK=3)", async () => {
    fakeHits = [
      makeHit("b.md", 1, 2, "snip b", 0.1),
      makeHit("c.md", 1, 2, "snip c", 0.9),
      makeHit("d.md", 1, 2, "snip d", 0.5),
      makeHit("zero.md", 1, 2, "snip zero", 0),
    ];
    const cue = await call(TOPIC);
    const entries = entryLines(cue);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("c.md"); // 0.9 first
    expect(entries[1]).toContain("d.md"); // 0.5 second
    expect(entries[2]).toContain("b.md"); // 0.1 third
    expect(cue).not.toContain("zero.md");
  });

  it("trusts backend order when ALL scores are zero (Stash-style ranking-less results)", async () => {
    fakeHits = [
      makeHit("z.md", 1, 2, "snip z", 0),
      makeHit("y.md", 1, 2, "snip y", 0),
      makeHit("x.md", 1, 2, "snip x", 0),
      makeHit("w.md", 1, 2, "snip w", 0),
    ];
    const cue = await call(TOPIC);
    const entries = entryLines(cue);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("z.md");
    expect(entries[1]).toContain("y.md");
    expect(entries[2]).toContain("x.md");
  });

  it("honors an explicit topK override (1)", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
      makeHit("c.md", 1, 2, "snip c", 0.7),
    ];
    const cue = await call(TOPIC, { topK: 1 });
    expect(entryLines(cue)).toHaveLength(1);
  });

  it("clamps an oversized topK to 10", async () => {
    fakeHits = Array.from({ length: 12 }, (_, i) => makeHit(`${i}.md`, 1, 2, `snip ${i}`, 0.9 - i * 0.01));
    const cue = await call(TOPIC, { topK: 99 });
    expect(entryLines(cue)).toHaveLength(10);
  });

  it("falls back to the default topK (3) when topK is 0", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
      makeHit("c.md", 1, 2, "snip c", 0.7),
      makeHit("d.md", 1, 2, "snip d", 0.6),
    ];
    const cue = await call(TOPIC, { topK: 0 });
    expect(entryLines(cue)).toHaveLength(3);
  });

  it("honors the settings topK when no explicit override is given", async () => {
    fakeHits = [
      makeHit("a.md", 1, 2, "snip a", 0.9),
      makeHit("b.md", 1, 2, "snip b", 0.8),
    ];
    const cue = await call(TOPIC, { settings: makeSettings({ memoryPerTurnRecallTopK: 1 }) });
    expect(entryLines(cue)).toHaveLength(1);
  });
});

// ── 800-char cue budget (whole-entry drops only) ──

describe("800-char cue budget", () => {
  it("never exceeds PER_TURN_RECALL_CUE_MAX_CHARS and only drops whole trailing entries", async () => {
    const longSnippet = "snippet ".repeat(26).trim(); // 160 chars
    fakeHits = [
      makeHit("h1.md", 1, 2, longSnippet, 0.9),
      makeHit("h2.md", 1, 2, longSnippet, 0.8),
      makeHit("h3.md", 1, 2, longSnippet, 0.7),
      makeHit("h4.md", 1, 2, longSnippet, 0.6),
    ];
    const cue = await call(TOPIC);
    expect(cue).not.toBe("");
    expect(cue.length).toBeLessThanOrEqual(PER_TURN_RECALL_CUE_MAX_CHARS);
    // Every entry line is a complete numbered entry (no partial entry survives).
    for (const line of cue.split("\n")) {
      if (line.includes("snippet")) {
        expect(/^\d+\. `/.test(line)).toBe(true);
      }
    }
    expect(cue).toContain(MEMORY_PRE_STEERING_MARKER);
    expect(cue).toContain("Use fn_memory_get");
  });
});

// ── Bounded session-scoped dedup registry (FIFO eviction) ──

describe("dedup registry bounds", () => {
  it("evicts the oldest session key after PER_TURN_RECALL_DEDUP_MAX_SESSIONS insertions", async () => {
    // Fill the registry: one distinct topic per session key.
    for (let s = 0; s < PER_TURN_RECALL_DEDUP_MAX_SESSIONS; s++) {
      fakeHits = [makeHit("m.md", 1, 2, `fill ${s}`, 0.9)];
      const cue = await call(`alpha ${s}`, { sessionKey: `s${s}` });
      expect(cue).not.toBe("");
    }
    // A brand-new session at capacity evicts the oldest (s0).
    fakeHits = [makeHit("m.md", 1, 2, "evict", 0.9)];
    expect(await call("alpha 999", { sessionKey: "s-overflow" })).not.toBe("");

    // s2 is still present → still deduped (assert before the next eviction disturbs it).
    fakeHits = [makeHit("m.md", 1, 2, "fill 2", 0.9)];
    expect(await call("alpha 2", { sessionKey: "s2" })).toBe("");
    // s0's signature is evicted → its cue is injected again.
    fakeHits = [makeHit("m.md", 1, 2, "fill 0", 0.9)];
    expect(await call("alpha 0", { sessionKey: "s0" })).not.toBe("");
  });

  it("evicts the oldest signature after PER_TURN_RECALL_DEDUP_MAX_SIGNATURES per-session insertions", async () => {
    for (let t = 0; t < PER_TURN_RECALL_DEDUP_MAX_SIGNATURES + 1; t++) {
      fakeHits = [makeHit("m.md", 1, 2, `topic ${t}`, 0.9)];
      expect(await call(`beta ${t}`, { sessionKey: "one-session" })).not.toBe("");
    }
    // t0's signature was shifted out → re-injected.
    fakeHits = [makeHit("m.md", 1, 2, "topic 0", 0.9)];
    expect(await call("beta 0", { sessionKey: "one-session" })).not.toBe("");
    // The newest signature (t63) is still retained → still deduped.
    fakeHits = [makeHit("m.md", 1, 2, `topic ${PER_TURN_RECALL_DEDUP_MAX_SIGNATURES - 1}`, 0.9)];
    expect(await call(`beta ${PER_TURN_RECALL_DEDUP_MAX_SIGNATURES - 1}`, { sessionKey: "one-session" })).toBe("");
  });
});
