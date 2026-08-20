// @vitest-environment node

/**
 * FNXC:RUFU121StashTests 2026-08-18-19:53:
 * RUFU-121: deterministic Stash backend tests (Step 1 — session-folder
 * auto-assignment + event metadata enrichment). All HTTP goes through the
 * injectable transport seam with a recorder fake — no real network.
 *
 * Contract under test:
 * - capture()/write() stamp top-level `session_folder_id` on every batch
 *   event when a project identity is present (get-or-create by stable
 *   external_key `fusion-<projectId>`, display name `Fusion — <project>`
 *   with a U+2014 em dash, fallback `Fusion`).
 * - Folder cache: successes only, 1h TTL, key `${baseUrl}::${projectId}`,
 *   failures never cached (fail-open, retried next capture).
 * - Identity metadata enrichment (`project`/`project_name`/`chat_title`)
 *   appears only when the value is present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  StashMemoryBackend,
  __resetStashFolderCacheForTests,
  __resetVectorCapabilityCacheForTests,
  normalizeStashSearchQuery,
  queryStashEvents,
  deleteStashChatSession,
  deleteStashChatSessions,
  bulkDeleteStashChatSessions,
  DEFAULT_STASH_BULK_MAX_PAGES,
  type StashHttpClient,
  type StashBulkDeleteStore,
} from "../memory-backend-stash.js";
import { resolveMemoryBackend, getMemoryBackend } from "../memory-backend.js";

type RecordedCall = { path: string; method: string; payload?: unknown };

/** Deterministic Stash transport fake: records every call, responds per path. */
function makeFakeHttp(
  impl: (path: string, method: string, payload?: unknown) => unknown | Promise<unknown> = () => null,
) {
  const calls: RecordedCall[] = [];
  const client: StashHttpClient = async (path, method, payload) => {
    calls.push({ path, method, payload });
    return impl(path, method, payload);
  };
  const folderCalls = () => calls.filter((c) => c.path === "/api/v1/me/session-folders/get-or-create");
  const batchCalls = () => calls.filter((c) => c.path === "/api/v1/me/sessions/events/batch") as Array<{
    path: string;
    method: string;
    payload: { events: Array<Record<string, any>> };
  }>;
  return { calls, client, folderCalls, batchCalls };
}

/** RUFU-121 folder-cache TTL (pinned by spec: 3,600,000 ms ≈ 1h). */
const FOLDER_TTL_MS = 3_600_000;

describe("StashMemoryBackend session-folder auto-assignment (RUFU-121 Step 1)", () => {
  beforeEach(() => {
    __resetStashFolderCacheForTests();
  });

  it("stamps session_folder_id on every batch event and resolves the folder by stable external_key", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-1", name: "Fusion — Demo" };
      if (path === "/api/v1/me/sessions/events/batch") return [{ id: "e1" }, { id: "e2" }];
      return null;
    });
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({
      baseUrl: "http://stash.test",
      apiKey: "k",
      now: () => nowMs,
      httpClient: fake.client,
    });

    const result = await backend.capture(
      "ses-1",
      [
        { event_type: "user_message", content: "hi" },
        { event_type: "assistant_message", content: "yo", agent_name: "claude" },
      ],
      { projectId: "proj_1", projectName: "Demo", chatTitle: "Chat title", projectRoot: "/proj/demo" },
    );

    expect(result).toEqual({ ok: true, inserted: 2, deduped: 0 });

    // Folder resolved once, with the display name + stable external_key.
    const folders = fake.folderCalls();
    expect(folders).toHaveLength(1);
    expect(folders[0].payload).toEqual({ name: "Fusion — Demo", external_key: "fusion-proj_1" });

    // Both events stamped with the folder id; per-event overrides preserved.
    const events = fake.batchCalls()[0].payload.events;
    expect(events).toHaveLength(2);
    expect(events[0].session_folder_id).toBe("folder-1");
    expect(events[1].session_folder_id).toBe("folder-1");
    expect(events[1].agent_name).toBe("claude");

    // Identity metadata enrichment (RUFU-121).
    expect(events[0].metadata).toMatchObject({
      project: "proj_1",
      project_name: "Demo",
      chat_title: "Chat title",
      session_id: "ses-1",
    });
  });

  it("uses the cached folder id within the TTL (no second get-or-create)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-1" };
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", now: () => nowMs, httpClient: fake.client });
    const meta = { projectId: "proj_1", projectName: "Demo" };

    await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], meta);
    nowMs += 60_000; // 1 minute later — well inside the 1h TTL
    const second = await backend.capture("ses-2", [{ event_type: "user_message", content: "b" }], meta);

    expect(second.ok).toBe(true);
    expect(fake.folderCalls()).toHaveLength(1);
    expect(fake.batchCalls()[1].payload.events[0].session_folder_id).toBe("folder-1");
  });

  it("misses the cache after the 1h TTL and re-resolves", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-1" };
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", now: () => nowMs, httpClient: fake.client });
    const meta = { projectId: "proj_1" };

    await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], meta);
    nowMs += FOLDER_TTL_MS + 1; // past the TTL
    await backend.capture("ses-2", [{ event_type: "user_message", content: "b" }], meta);

    expect(fake.folderCalls()).toHaveLength(2);
  });

  it("fails open on folder resolution failure and never caches the failure", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") throw new Error("Stash returned 503");
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", now: () => nowMs, httpClient: fake.client });
    const meta = { projectId: "proj_2" };

    const result = await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], meta);
    expect(result.ok).toBe(true); // capture still lands
    expect(fake.batchCalls()[0].payload.events[0].session_folder_id).toBeUndefined();

    // Failure was NOT cached — the next capture retries get-or-create.
    await backend.capture("ses-2", [{ event_type: "user_message", content: "b" }], meta);
    expect(fake.folderCalls()).toHaveLength(2);
    expect(fake.batchCalls()[1].payload.events[0].session_folder_id).toBeUndefined();
  });

  it("skips folder resolution entirely when no project identity is present (backward compat)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], { projectRoot: "/proj/demo" });

    expect(fake.folderCalls()).toHaveLength(0);
    const event = fake.batchCalls()[0].payload.events[0];
    expect(event.session_folder_id).toBeUndefined();
    expect("project" in event.metadata).toBe(false);
    expect("project_name" in event.metadata).toBe(false);
    expect("chat_title" in event.metadata).toBe(false);
  });

  it("enriches metadata keys conditionally — only when the value is present", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-9" };
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    // projectId only: project present, project_name/chat_title absent.
    await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], { projectId: "proj_9" });
    const metaOnlyId = fake.batchCalls()[0].payload.events[0].metadata as Record<string, unknown>;
    expect("project" in metaOnlyId).toBe(true);
    expect("project_name" in metaOnlyId).toBe(false);
    expect("chat_title" in metaOnlyId).toBe(false);

    // project + title, no name.
    await backend.capture("ses-1", [{ event_type: "user_message", content: "b" }], {
      projectId: "proj_9",
      chatTitle: "My Chat",
    });
    const metaWithTitle = fake.batchCalls()[1].payload.events[0].metadata as Record<string, unknown>;
    expect(metaWithTitle).toMatchObject({ project: "proj_9", chat_title: "My Chat" });
    expect("project_name" in metaWithTitle).toBe(false);
  });

  it("falls back to the bare `Fusion` folder name when the project name is missing or blank", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-1" };
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    await backend.capture("ses-1", [{ event_type: "user_message", content: "a" }], { projectId: "proj_a" });
    expect(fake.folderCalls()[0].payload).toEqual({ name: "Fusion", external_key: "fusion-proj_a" });

    // Whitespace-only name also falls back (different projectId → different cache key).
    await backend.capture("ses-1", [{ event_type: "user_message", content: "b" }], {
      projectId: "proj_b",
      projectName: "   ",
    });
    expect(fake.folderCalls()[1].payload).toEqual({ name: "Fusion", external_key: "fusion-proj_b" });
  });

  it("scopes the folder cache by baseUrl (different Stash instances never share a folder id)", async () => {
    const mk = (baseUrl: string) =>
      makeFakeHttp((path) => {
        if (path === "/api/v1/me/session-folders/get-or-create") return { id: `folder-${baseUrl}` };
        if (path === "/api/v1/me/sessions/events/batch") return [];
        return null;
      });
    const a = mk("http://stash-a.test");
    const b = mk("http://stash-b.test");
    const backendA = new StashMemoryBackend({ baseUrl: "http://stash-a.test", httpClient: a.client });
    const backendB = new StashMemoryBackend({ baseUrl: "http://stash-b.test", httpClient: b.client });
    const meta = { projectId: "same-project" };

    await backendA.capture("ses-1", [{ event_type: "user_message", content: "a" }], meta);
    await backendB.capture("ses-1", [{ event_type: "user_message", content: "b" }], meta);

    expect(a.folderCalls()).toHaveLength(1);
    expect(b.folderCalls()).toHaveLength(1);
    expect(b.batchCalls()[0].payload.events[0].session_folder_id).toBe("folder-http://stash-b.test");
  });

  it("write() stamps session_folder_id and enriches metadata when identity is present", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-7" };
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    const long = "x".repeat(5_000);
    const result = await backend.write("/proj/demo", long, { projectId: "proj_7", projectName: "Demo" });

    expect(result).toEqual({ success: true, backend: "stash" });
    expect(fake.folderCalls()[0].payload).toEqual({ name: "Fusion — Demo", external_key: "fusion-proj_7" });
    const event = fake.batchCalls()[0].payload.events[0];
    expect(event.event_type).toBe("memory");
    expect(event.content).toBe("x".repeat(4_000)); // 4000-char truncation preserved
    expect(event.session_folder_id).toBe("folder-7");
    expect(event.metadata).toMatchObject({ project: "proj_7", project_name: "Demo" });
    expect("chat_title" in event.metadata).toBe(false);
  });

  it("write() without identity performs no folder call and no identity metadata (2-arg callers unchanged)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/events/batch") return [];
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    const result = await backend.write("/proj/demo", "hello");

    expect(result).toEqual({ success: true, backend: "stash" });
    expect(fake.folderCalls()).toHaveLength(0);
    const event = fake.batchCalls()[0].payload.events[0];
    expect(event.session_folder_id).toBeUndefined();
    expect("project" in event.metadata).toBe(false);
    expect("project_name" in event.metadata).toBe(false);
  });

  it("write() still fails closed to {success:false} when the batch POST fails", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/session-folders/get-or-create") return { id: "folder-1" };
      if (path === "/api/v1/me/sessions/events/batch") throw new Error("Stash returned 500");
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });

    const result = await backend.write("/proj/demo", "hello", { projectId: "proj_1" });
    expect(result).toEqual({ success: false, backend: "stash" });
  });
});

/**
 * FNXC:RUFU121SearchTests 2026-08-18-19:53:
 * RUFU-121 Step 2 — recall-query normalization + structured query +
 * session-delete helper. Deterministic fakes only, no network.
 */
describe("normalizeStashSearchQuery (RUFU-121 Step 2)", () => {
  it("satisfies the spec normalization table", () => {
    expect(normalizeStashSearchQuery("LCM B.1 B.2 priorita plan")).toBe("LCM");
    expect(normalizeStashSearchQuery("memory OR recall")).toBe("memory OR recall");
    expect(normalizeStashSearchQuery("a OR b OR c d")).toBe("a OR b OR c d");
    expect(normalizeStashSearchQuery("café résumé")).toBe("caf");
    expect(normalizeStashSearchQuery("  LCM   plan  ")).toBe("LCM");
  });

  it("returns empty for null/undefined/empty/whitespace-only input", () => {
    expect(normalizeStashSearchQuery(null)).toBe("");
    expect(normalizeStashSearchQuery(undefined)).toBe("");
    expect(normalizeStashSearchQuery("")).toBe("");
    expect(normalizeStashSearchQuery("   ")).toBe("");
  });

  it("caps at 100 chars on a token boundary (drop trailing tokens, never mid-token)", () => {
    // Exactly-150-char OR input: 40 + " OR " + 50 + " OR " + 52 = 150.
    const input = "a".repeat(40) + " OR " + "b".repeat(50) + " OR " + "c".repeat(52);
    expect(input.length).toBe(150);
    const out = normalizeStashSearchQuery(input);
    // 40 + 1 + 2 + 1 + 50 + 1 + 2 = 97 ≤ 100; the 52-char trailing token is
    // dropped whole, not truncated mid-token.
    expect(out).toBe("a".repeat(40) + " OR " + "b".repeat(50) + " OR");
    expect(out.length).toBeLessThanOrEqual(100);
    // A single oversized token (150 chars) is dropped whole — the result stays
    // on a token boundary (""), never a mid-token cut.
    expect(normalizeStashSearchQuery("a".repeat(150))).toBe("");
  });

  it("lowercase 'or' / 'Or' does NOT trigger OR mode (case-sensitive exact match)", () => {
    expect(normalizeStashSearchQuery("or postgres")).toBe("or");
    expect(normalizeStashSearchQuery("Or postgres")).toBe("Or");
  });

  it("drops pure-punctuation tokens and tokens that clean to empty", () => {
    expect(normalizeStashSearchQuery("??? OR hello ???")).toBe("OR hello");
    expect(normalizeStashSearchQuery("??? hello")).toBe("hello");
    expect(normalizeStashSearchQuery("Hello, world!")).toBe("Hello");
  });
});

describe("StashMemoryBackend.search URL contract (RUFU-121 Step 2)", () => {
  function searchFake() {
    const fake = makeFakeHttp((path) => {
      if (path.startsWith("/api/v1/me/sessions/events/search")) return { results: [] };
      return null;
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });
    const searchPath = () => fake.calls.filter((c) => c.path.startsWith("/api/v1/me/sessions/events/search")).pop()?.path;
    return { fake, backend, searchPath };
  }

  it("preserves the legacy URL BYTE-IDENTICAL for an empty query", async () => {
    const { backend, searchPath } = searchFake();
    await backend.search("/proj/demo", { query: "" });
    expect(searchPath()).toBe("/api/v1/me/sessions/events/search?q=&limit=5");
  });

  it("preserves the legacy URL BYTE-IDENTICAL for a whitespace-only query", async () => {
    const { backend, searchPath } = searchFake();
    await backend.search("/proj/demo", { query: "  " });
    expect(searchPath()).toBe("/api/v1/me/sessions/events/search?q=%20%20&limit=5");
  });

  it("normalizes a non-empty query into q= and drops the inert topic param", async () => {
    const { backend, searchPath, fake } = searchFake();
    await backend.search("/proj/demo", { query: "postgres connection pooling", topic: "mytopic" });
    expect(searchPath()).toBe("/api/v1/me/sessions/events/search?q=postgres&limit=5");
    expect(searchPath()).not.toContain("topic");
    expect(fake.calls).toHaveLength(1);
  });

  it("returns [] with NO HTTP call when a non-blank query normalizes to empty", async () => {
    const { backend, fake } = searchFake();
    const results = await backend.search("/proj/demo", { query: "??? !!!" });
    expect(results).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("clamps limit into 1..20 (Stash hard limit) and keeps the legacy shape", async () => {
    const { backend, searchPath } = searchFake();
    await backend.search("/proj/demo", { query: "", limit: 0 });
    expect(searchPath()).toBe("/api/v1/me/sessions/events/search?q=&limit=1");
    await backend.search("/proj/demo", { query: "", limit: 1000 });
    expect(searchPath()).toBe("/api/v1/me/sessions/events/search?q=&limit=20");
  });
});

describe("StashMemoryBackend vector-first search (RUFU-126 Step 5)", () => {
  const SEMANTIC_PREFIX = "/api/v1/me/sessions/events/semantic-search";
  const KEYWORD_PREFIX = "/api/v1/me/sessions/events/search";
  /** RUFU-126 negative vector-capability cache TTL (pinned: 3,600,000 ms ≈ 1h). */
  const VECTOR_TTL_MS = 3_600_000;

  function makeVectorFake(
    semantic: (path: string) => unknown,
    keyword: (path: string) => unknown = () => ({ results: [] }),
  ) {
    const fake = makeFakeHttp((path) => {
      if (path.startsWith(SEMANTIC_PREFIX)) return semantic(path);
      if (path.startsWith(KEYWORD_PREFIX)) return keyword(path);
      return null;
    });
    const semanticCalls = () => fake.calls.filter((c) => c.path.startsWith(SEMANTIC_PREFIX));
    const keywordCalls = () => fake.calls.filter((c) => c.path.startsWith(KEYWORD_PREFIX));
    return { fake, semanticCalls, keywordCalls };
  }

  /** Reject exactly like the real transport seam for a non-2xx response. */
  function stashStatus(code: number): () => never {
    return () => {
      throw new Error(`Stash returned ${code}: body`);
    };
  }

  beforeEach(() => {
    __resetVectorCapabilityCacheForTests();
    __resetStashFolderCacheForTests();
  });

  it("1. flag off (default) + multi-word query → keyword URL only, no semantic URL", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(() => {
      throw new Error("semantic endpoint must not be called when the flag is off");
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client });
    const results = await backend.search("/proj/demo", { query: "LCM B.1 B.2 priorita plan" });
    expect(results).toEqual([]);
    expect(semanticCalls()).toHaveLength(0);
    expect(keywordCalls()).toHaveLength(1);
    expect(keywordCalls()[0].path).toBe("/api/v1/me/sessions/events/search?q=LCM&limit=5");
  });

  it("2. flag on + multi-word + semantic 200 hits → semantic URL first (raw trimmed q), no keyword URL, D5 scores mapped", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(() => ({
      events: [
        { id: "ev-1", session_id: "ses-9", content: "first hit content is here", rank: 0.91 },
        { id: "ev-2", session_id: "ses-9", content: "second hit content", rank: 0.42 },
      ],
    }));
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client, vectorSearch: true });
    const results = await backend.search("/proj/demo", { query: "  LCM B.1 B.2 priorita plan  " });

    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(0);
    expect(semanticCalls()[0].path).toBe(
      `/api/v1/me/sessions/events/semantic-search?q=${encodeURIComponent("LCM B.1 B.2 priorita plan")}&limit=5`,
    );
    expect(results).toEqual([
      {
        path: "stash://session/ses-9",
        lineStart: 1,
        lineEnd: 1,
        snippet: "first hit content is here",
        score: 0.91,
        backend: "stash",
      },
      {
        path: "stash://session/ses-9",
        lineStart: 1,
        lineEnd: 1,
        snippet: "second hit content",
        score: 0.42,
        backend: "stash",
      },
    ]);
  });

  it("3. flag on + multi-word + semantic 404 (unpatched server) → keyword fallback with normalized q; negative-cached within TTL; retried after TTL", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(
      stashStatus(404),
      () => ({ results: [{ id: "kw-1", content: "keyword hit", session_id: "kw-ses" }] }),
    );
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", now: () => nowMs, httpClient: fake.client, vectorSearch: true });

    const results = await backend.search("/proj/demo", { query: "LCM B.1 B.2 priorita plan" });
    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(1);
    expect(keywordCalls()[0].path).toBe("/api/v1/me/sessions/events/search?q=LCM&limit=5");
    expect(results).toEqual([
      {
        path: "stash://session/kw-ses",
        lineStart: 1,
        lineEnd: 1,
        snippet: "keyword hit",
        score: 2,
        backend: "stash",
      },
    ]);

    // Second multi-word call within the TTL: no semantic attempt (negative cache).
    await backend.search("/proj/demo", { query: "other multi word query" });
    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(2);

    // After the 1h TTL expires: the semantic URL is retried.
    nowMs += VECTOR_TTL_MS + 1;
    await backend.search("/proj/demo", { query: "yet another multi word" });
    expect(semanticCalls()).toHaveLength(2);
    expect(keywordCalls()).toHaveLength(3);
  });

  it("4. flag on + multi-word + semantic 503 (embedder unconfigured) → keyword fallback; negative cached within TTL", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(stashStatus(503), () => ({ results: [] }));
    let nowMs = 1_000;
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", now: () => nowMs, httpClient: fake.client, vectorSearch: true });

    await backend.search("/proj/demo", { query: "two word query" });
    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(1);

    nowMs += 60_000; // within TTL — suppressed
    await backend.search("/proj/demo", { query: "three word query now" });
    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(2);
  });

  it.each([
    ["500 error", stashStatus(500)],
    [
      "network error",
      () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3456");
      },
    ],
    ["malformed body (empty 2xx resolves null)", () => null],
    ["malformed body (results not an array)", () => ({ results: "nope" })],
    ["empty result list", () => ({ events: [] })],
  ])("5. %s → keyword fallback on EVERY call (never negatively cached)", async (_label, semanticImpl) => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(semanticImpl, () => ({ results: [] }));
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client, vectorSearch: true });

    await backend.search("/proj/demo", { query: "first two words" });
    await backend.search("/proj/demo", { query: "second pair words" });
    expect(semanticCalls()).toHaveLength(2);
    expect(keywordCalls()).toHaveLength(2);
  });

  it("6. flag on + single-word query → keyword only; semantic URL never called", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(() => {
      throw new Error("semantic endpoint must not be called for single-word queries");
    });
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client, vectorSearch: true });
    await backend.search("/proj/demo", { query: "postgres" });
    await backend.search("/proj/demo", { query: "B.1" });
    expect(semanticCalls()).toHaveLength(0);
    expect(keywordCalls()).toHaveLength(2);
    expect(keywordCalls()[0].path).toBe("/api/v1/me/sessions/events/search?q=postgres&limit=5");
    // RUFU-121 normalization strips punctuation: "B.1" → "B1".
    expect(keywordCalls()[1].path).toBe("/api/v1/me/sessions/events/search?q=B1&limit=5");
  });

  it("7. semantic hits with rank missing/null → score 1.0; server order preserved", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(() => ({
      events: [
        { id: "a", content: "no rank field" },
        { id: "b", content: "explicit null rank", rank: null },
        { id: "c", content: "real rank", rank: 0.77 },
      ],
    }));
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client, vectorSearch: true });
    const results = await backend.search("/proj/demo", { query: "multi word query" });

    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(0);
    expect(results.map((r) => r.score)).toEqual([1.0, 1.0, 0.77]);
    expect(results.map((r) => r.path)).toEqual(["stash://event/a", "stash://event/b", "stash://event/c"]);
  });

  it("8. resolveMemoryBackend materializes the vector flag; shared registry default instance stays disabled", () => {
    const on = resolveMemoryBackend({ memoryBackendType: "stash", stashVectorSearch: true });
    expect(on).toBeInstanceOf(StashMemoryBackend);
    expect((on as { vectorSearch: boolean }).vectorSearch).toBe(true);

    const offDefault = resolveMemoryBackend({ memoryBackendType: "stash" });
    expect(offDefault).toBeInstanceOf(StashMemoryBackend);
    expect((offDefault as { vectorSearch: boolean }).vectorSearch).toBe(false);

    const offExplicit = resolveMemoryBackend({ memoryBackendType: "stash", stashVectorSearch: false });
    expect((offExplicit as { vectorSearch: boolean }).vectorSearch).toBe(false);

    const shared = getMemoryBackend("stash");
    expect(shared).toBeInstanceOf(StashMemoryBackend);
    expect((shared as { vectorSearch: boolean }).vectorSearch).toBe(false);
  });

  it("9. fail-closed: semantic error AND keyword error → [] (no throw)", async () => {
    const { fake, semanticCalls, keywordCalls } = makeVectorFake(
      stashStatus(503),
      () => {
        throw new Error("Stash returned 500: kw down");
      },
    );
    const backend = new StashMemoryBackend({ baseUrl: "http://stash.test", httpClient: fake.client, vectorSearch: true });
    const results = await backend.search("/proj/demo", { query: "two word query" });
    expect(results).toEqual([]);
    expect(semanticCalls()).toHaveLength(1);
    expect(keywordCalls()).toHaveLength(1);
  });
});

describe("queryStashEvents (RUFU-121 Step 2)", () => {
  it("builds the structured event-query path with all filters and defaults", async () => {
    const fake = makeFakeHttp(() => ({ events: [{ id: "e1" }], has_more: true }));
    const result = await queryStashEvents("http://stash.test", "k", {
      agentName: "fusion",
      sessionId: "s1",
      eventType: "note",
      after: "2026-01-01T00:00:00Z",
      before: "2026-02-01T00:00:00Z",
      limit: 10,
      order: "asc",
    }, fake.client);
    expect(fake.calls[0].path).toBe(
      "/api/v1/me/sessions/events?agent_name=fusion&session_id=s1&event_type=note"
      + "&after=2026-01-01T00%3A00%3A00Z&before=2026-02-01T00%3A00%3A00Z&limit=10&order=asc",
    );
    expect(result).toEqual({ events: [{ id: "e1" }], hasMore: true });
  });

  it("applies the default limit=50 and order=desc when omitted", async () => {
    const fake = makeFakeHttp(() => ({ events: [] }));
    await queryStashEvents("http://stash.test", "k", {}, fake.client);
    expect(fake.calls[0].path).toBe("/api/v1/me/sessions/events?limit=50&order=desc");
  });

  it("clamps limit into Stash's 1..200 hard limit", async () => {
    const fake = makeFakeHttp(() => ({ events: [] }));
    await queryStashEvents("http://stash.test", "k", { limit: 500 }, fake.client);
    expect(fake.calls[0].path).toBe("/api/v1/me/sessions/events?limit=200&order=desc");
    await queryStashEvents("http://stash.test", "k", { limit: 0 }, fake.client);
    expect(fake.calls[1].path).toBe("/api/v1/me/sessions/events?limit=1&order=desc");
  });

  it("degrades a malformed/missing events payload to [] and hasMore=false", async () => {
    const fakeNull = makeFakeHttp(() => null);
    await expect(queryStashEvents("http://stash.test", "k", {}, fakeNull.client)).resolves.toEqual({
      events: [],
      hasMore: false,
    });
    const fakeNoEvents = makeFakeHttp(() => ({ has_more: true }));
    await expect(queryStashEvents("http://stash.test", "k", {}, fakeNoEvents.client)).resolves.toEqual({
      events: [],
      hasMore: true,
    });
  });

  it("propagates transport errors to the caller (caller owns degradation)", async () => {
    const fake = makeFakeHttp(() => { throw new Error("Stash returned 500"); });
    await expect(queryStashEvents("http://stash.test", "k", {}, fake.client)).rejects.toThrow("500");
  });
});

describe("deleteStashChatSession (RUFU-130 by-id lookup)", () => {
  it("soft-deletes the row found by the single-shot by-id lookup (no list call)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/chat-ses-1") return { id: "row-1", session_id: "chat-ses-1" };
      // Any session-list call (a regression to the scan) gets the null
      // default → not-found → this exact-sequence assertion goes red.
      return null;
    });
    const result = await deleteStashChatSession("http://stash.test", "k", "chat-ses-1", fake.client);
    expect(result).toEqual({ deleted: true, status: "ok" });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions/chat-ses-1",
      "DELETE /api/v1/me/sessions/row-1",
    ]);
  });

  it("accepts a numeric row id from the lookup payload", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/s") return { id: 42, session_id: "s" };
      return null;
    });
    const result = await deleteStashChatSession("http://stash.test", "k", "s", fake.client);
    expect(result).toEqual({ deleted: true, status: "ok" });
    expect(fake.calls[1].path).toBe("/api/v1/me/sessions/42");
  });

  it("resolves not-found on a lookup 404 — exactly one call, no DELETE", async () => {
    const fake = makeFakeHttp(() => { throw new Error("Stash returned 404: Not Found"); });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fake.client)).resolves.toEqual({
      deleted: false,
      status: "not-found",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/me/sessions/s" });
  });

  it("resolves skipped on a lookup network/500 error — never throws", async () => {
    const fake = makeFakeHttp(() => { throw new Error("Stash returned 500: Internal"); });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fake.client)).resolves.toEqual({
      deleted: false,
      status: "skipped",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    ["a missing id", {}],
    ["a null id", { id: null, session_id: "s" }],
  ])("resolves not-found WITHOUT a DELETE when the lookup 200 has %s", async (_label, payload) => {
    const fake = makeFakeHttp((path) => (path === "/api/v1/me/sessions/s" ? payload : null));
    const result = await deleteStashChatSession("http://stash.test", "k", "s", fake.client);
    expect(result).toEqual({ deleted: false, status: "not-found" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("GET");
  });

  it("classifies DELETE-side failures after a found row: 404 → not-found, 500 → skipped", async () => {
    const fakeDelete404 = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/s") return { id: "row-1", session_id: "s" };
      throw new Error("Stash returned 404: Not Found");
    });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fakeDelete404.client)).resolves.toEqual({
      deleted: false,
      status: "not-found",
    });
    expect(fakeDelete404.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions/s",
      "DELETE /api/v1/me/sessions/row-1",
    ]);
    const fakeDelete500 = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions/s") return { id: "row-1", session_id: "s" };
      throw new Error("Stash returned 500: Internal");
    });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fakeDelete500.client)).resolves.toEqual({
      deleted: false,
      status: "skipped",
    });
    expect(fakeDelete500.calls).toHaveLength(2);
  });

  it("percent-encodes the session id in the lookup path", async () => {
    const fake = makeFakeHttp(() => { throw new Error("Stash returned 404: Not Found"); });
    await expect(deleteStashChatSession("http://stash.test", "k", "chat a b", fake.client)).resolves.toEqual({
      deleted: false,
      status: "not-found",
    });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions/chat%20a%20b",
    ]);
  });
});

/** 200 unrelated filler rows — a full page that keeps the scan moving. */
function fillerRows(count: number, prefix = "filler") {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, session_id: `${prefix}-${i}` }));
}

describe("deleteStashChatSessions (RUFU-125 Step 1)", () => {
  it("returns a zeroed result with ZERO HTTP for empty / all-blank / duplicate-only ids", async () => {
    const empty = makeFakeHttp();
    await expect(deleteStashChatSessions("http://stash.test", "k", [], { http: empty.client })).resolves.toEqual({
      targets: 0, matched: 0, deleted: 0, pagesScanned: 0, truncated: false,
    });
    expect(empty.calls).toHaveLength(0);

    const blanks = makeFakeHttp();
    await expect(
      deleteStashChatSessions("http://stash.test", "k", ["", "   ", "\t"], { http: blanks.client }),
    ).resolves.toEqual({ targets: 0, matched: 0, deleted: 0, pagesScanned: 0, truncated: false });
    expect(blanks.calls).toHaveLength(0);
  });

  it("collapses duplicate ids into one target before any HTTP", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method === "GET") return { sessions: [{ id: "row-1", session_id: "chat-dup" }] };
      return null;
    });
    const result = await deleteStashChatSessions(
      "http://stash.test", "k", ["chat-dup", "chat-dup", "chat-dup"], { http: fake.client },
    );
    expect(result).toEqual({ targets: 1, matched: 1, deleted: 1, pagesScanned: 1, truncated: false });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions?limit=200&offset=0",
      "DELETE /api/v1/me/sessions/row-1",
    ]);
  });

  it("single-page match: exact GET path, one percent-encoded DELETE per matched row, unrelated rows untouched", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method === "GET") {
        expect(path).toBe("/api/v1/me/sessions?limit=200&offset=0");
        return {
          sessions: [
            { id: "row a/b", session_id: "chat-aaa" },
            { id: "row-2", session_id: "unrelated" },
            { id: "row-3", session_id: "chat-bbb" },
          ],
        };
      }
      return null; // DELETE → 204
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["chat-aaa", "chat-bbb"], { http: fake.client });
    expect(result).toEqual({ targets: 2, matched: 2, deleted: 2, pagesScanned: 1, truncated: false });
    const deletes = fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toContain("/api/v1/me/sessions/row%20a%2Fb"); // percent-encoded row id
    expect(deletes).toContain("/api/v1/me/sessions/row-3");
    expect(deletes).not.toContain("/api/v1/me/sessions/row-2"); // unrelated row untouched
    expect(deletes).toHaveLength(2);
  });

  it("window-limitation proof: a target only present on page 2 (offset=200) is found and deleted", async () => {
    const page1 = fillerRows(200); // full page, no target
    const page2 = [{ id: "row-p2", session_id: "chat-page2" }];
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      return { sessions: offset === 0 ? page1 : page2 };
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["chat-page2"], { http: fake.client });
    expect(result).toEqual({ targets: 1, matched: 1, deleted: 1, pagesScanned: 2, truncated: false });
    const gets = fake.calls.filter((c) => c.method === "GET").map((c) => c.path);
    expect(gets).toEqual(["/api/v1/me/sessions?limit=200&offset=0", "/api/v1/me/sessions?limit=200&offset=200"]);
    expect(fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(
      ["/api/v1/me/sessions/row-p2"],
    );
  });

  it("early stop: all targets matched on page 1 → NO second GET", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      return { sessions: [{ id: "row-1", session_id: "chat-only" }, ...fillerRows(199)] };
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["chat-only"], { http: fake.client });
    expect(result).toEqual({ targets: 1, matched: 1, deleted: 1, pagesScanned: 1, truncated: false });
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("window exhausted: a short page (< 200 rows) stops the scan, truncated: false", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      return { sessions: offset === 0 ? fillerRows(150) : [] };
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["never-listed"], { http: fake.client });
    expect(result).toEqual({ targets: 1, matched: 0, deleted: 0, pagesScanned: 1, truncated: false });
    // Unmatched target remains un-deleted; the short page proves the window is exhausted.
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("maxPages cap: default 10 pages, then truncated; opts.maxPages=2 override honored", async () => {
    // Fake that always returns a full 200-row page of unrelated rows.
    const makeAlwaysFull = () => makeFakeHttp((path, method) =>
      method === "GET" ? { sessions: fillerRows(200) } : null);

    const defaultFake = makeAlwaysFull();
    const defaultResult = await deleteStashChatSessions("http://stash.test", "k", ["never-listed"], { http: defaultFake.client });
    expect(DEFAULT_STASH_BULK_MAX_PAGES).toBe(10);
    expect(defaultResult).toEqual({
      targets: 1, matched: 0, deleted: 0, pagesScanned: 10, truncated: true,
    });
    expect(defaultFake.calls.filter((c) => c.method === "GET")).toHaveLength(10);
    expect(defaultFake.calls.filter((c) => c.method === "GET").at(-1)?.path)
      .toBe("/api/v1/me/sessions?limit=200&offset=1800");

    const cappedFake = makeAlwaysFull();
    const cappedResult = await deleteStashChatSessions(
      "http://stash.test", "k", ["never-listed"], { http: cappedFake.client, maxPages: 2 },
    );
    expect(cappedResult).toEqual({ targets: 1, matched: 0, deleted: 0, pagesScanned: 2, truncated: true });
    expect(cappedFake.calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("null-id rows (already soft-deleted) are never matchable: no DELETE, slot still consumed", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      return {
        sessions: [
          { id: null, session_id: "chat-gone" }, // already soft-deleted
          ...fillerRows(199),
        ],
      };
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["chat-gone"], { http: fake.client });
    expect(result.deleted).toBe(0);
    expect(result.pagesScanned).toBe(1);
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("GET failure on page 2 → partial result from page 1, no throw, truncated: true", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      if (offset === 0) {
        return { sessions: [{ id: "row-1", session_id: "chat-p1" }, ...fillerRows(199)] };
      }
      throw new Error("Stash returned 500: boom");
    });
    const result = await deleteStashChatSessions(
      "http://stash.test", "k", ["chat-p1", "chat-p2"], { http: fake.client },
    );
    expect(result).toEqual({ targets: 2, matched: 1, deleted: 1, pagesScanned: 2, truncated: true });
  });

  it("GET failure on page 1 → zeroed partial, no throw, truncated: true", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "GET") return null;
      throw new Error("network down");
    });
    await expect(
      deleteStashChatSessions("http://stash.test", "k", ["chat-a"], { http: fake.client }),
    ).resolves.toEqual({ targets: 1, matched: 0, deleted: 0, pagesScanned: 1, truncated: true });
  });

  it("DELETE 404 on one row → not counted deleted, remaining rows still attempted", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "DELETE") {
        return { sessions: [
          { id: "row-a", session_id: "chat-a" },
          { id: "row-b", session_id: "chat-b" },
        ] };
      }
      if (path === "/api/v1/me/sessions/row-a") throw new Error("Stash returned 404: Not Found");
      return null; // row-b DELETE → 204
    });
    const result = await deleteStashChatSessions("http://stash.test", "k", ["chat-a", "chat-b"], { http: fake.client });
    expect(result).toEqual({ targets: 2, matched: 2, deleted: 1, pagesScanned: 1, truncated: false });
    const deletes = fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/api/v1/me/sessions/row-a", "/api/v1/me/sessions/row-b"]);
  });

  it("DELETE network error on one row → same: not counted, remaining rows still attempted", async () => {
    const fake = makeFakeHttp((path, method) => {
      if (method !== "DELETE") {
        return { sessions: [
          { id: "row-a", session_id: "chat-a" },
          { id: "row-b", session_id: "chat-b" },
        ] };
      }
      if (path === "/api/v1/me/sessions/row-a") throw new Error("ECONNRESET");
      return null;
    });
    await expect(
      deleteStashChatSessions("http://stash.test", "k", ["chat-a", "chat-b"], { http: fake.client }),
    ).resolves.toEqual({ targets: 2, matched: 2, deleted: 1, pagesScanned: 1, truncated: false });
    expect(fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path))
      .toEqual(["/api/v1/me/sessions/row-a", "/api/v1/me/sessions/row-b"]);
  });

  it("accepts a numeric row id (String-converted) and never rejects even under total transport failure", async () => {
    const numeric = makeFakeHttp((path, method) => {
      if (method !== "DELETE") return { sessions: [{ id: 4242, session_id: "chat-num" }] };
      return null;
    });
    const numericResult = await deleteStashChatSessions("http://stash.test", "k", ["chat-num"], { http: numeric.client });
    expect(numericResult.deleted).toBe(1);
    expect(numeric.calls.find((c) => c.method === "DELETE")?.path).toBe("/api/v1/me/sessions/4242");

    // Settles (never rejects) under total transport failure.
    const dead = makeFakeHttp(() => { throw new Error("Stash returned 503"); });
    await expect(deleteStashChatSessions("http://stash.test", "k", ["chat-x"], { http: dead.client })).resolves.toEqual({
      targets: 1, matched: 0, deleted: 0, pagesScanned: 1, truncated: true,
    });
  });
});

/** Minimal structural store for the bulkDeleteStashChatSessions wrapper tests. */
function makeBulkTestStore(
  settings: Record<string, unknown> | { reject: Error },
  secrets?: { id: string; key: string },
) {
  const store = {
    getSettings: vi.fn(async () => {
      if (typeof settings === "object" && "reject" in settings) throw settings.reject;
      return settings;
    }),
  };
  if (secrets) {
    store.getSecretsStore = vi.fn(async () => ({
      listSecrets: vi.fn(async () => [{ id: secrets.id, key: "stash-api-key" }]),
      revealSecret: vi.fn(async () => ({ plaintextValue: secrets.key })),
    }));
  }
  return store;
}

describe("bulkDeleteStashChatSessions (RUFU-125 Step 1)", () => {
  const STASH_SETTINGS = { memoryEnabled: true, memoryBackendType: "stash", stashUrl: "http://stash.test" };

  it("skips memory-disabled with zero HTTP", async () => {
    const store = makeBulkTestStore({ memoryEnabled: false, memoryBackendType: "stash" });
    const fake = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "memory-disabled" });
    expect(fake.calls).toHaveLength(0);
  });

  it("skips a non-stash backend with zero HTTP", async () => {
    const store = makeBulkTestStore({ memoryEnabled: true, memoryBackendType: "file" });
    const fake = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "non-stash-backend" });
    expect(fake.calls).toHaveLength(0);
  });

  it("skips unresolvable credentials (stash + url, no key, no secrets store) with zero HTTP", async () => {
    const store = makeBulkTestStore(STASH_SETTINGS);
    const fake = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "unresolvable-credentials" });
    expect(fake.calls).toHaveLength(0);
  });

  it("explicit settings.stashApiKey → full paged flow reaches the http client", async () => {
    const store = makeBulkTestStore({ ...STASH_SETTINGS, stashApiKey: "sk-explicit" });
    const fake = makeFakeHttp((path, method) => {
      if (method !== "DELETE") return { sessions: [{ id: "row-1", session_id: "chat-1" }] };
      return null;
    });
    const summary = await bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client });
    expect(summary).toEqual({
      skipped: false,
      result: { targets: 1, matched: 1, deleted: 1, pagesScanned: 1, truncated: false },
    });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions?limit=200&offset=0",
      "DELETE /api/v1/me/sessions/row-1",
    ]);
  });

  it("secrets-store path (listSecrets → revealSecret) resolves the key and invokes http", async () => {
    const store = makeBulkTestStore(STASH_SETTINGS, { id: "uuid-1", key: "sk-secret" }) as StashBulkDeleteStore & {
      getSecretsStore: ReturnType<typeof vi.fn>;
    };
    const fake = makeFakeHttp((path, method) => {
      if (method !== "DELETE") return { sessions: [{ id: "row-1", session_id: "chat-1" }] };
      return null;
    });
    const summary = await bulkDeleteStashChatSessions(store, ["chat-1"], { http: fake.client });
    expect(summary.skipped).toBe(false);
    expect(store.getSecretsStore).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(2);
  });

  it("blank/absent stashUrl does NOT skip — the sync proceeds against the resolved default URL", async () => {
    // RUFU-121's url-fix contract: a blank URL must never turn the sync into
    // a silent no-op; it falls back to DEFAULT_STASH_URL (mirrors
    // resolveMemoryBackend). The injected fake observes the path contract;
    // the base-URL fallback is the same DEFAULT_STASH_URL constant the route
    // sync and the real transport share.
    const blank = makeBulkTestStore({ memoryEnabled: true, memoryBackendType: "stash", stashUrl: "   ", stashApiKey: "sk-explicit" });
    const absent = makeBulkTestStore({ memoryEnabled: true, memoryBackendType: "stash", stashApiKey: "sk-explicit" });
    for (const store of [blank, absent]) {
      const fake = makeFakeHttp((path, method) => {
        if (method !== "DELETE") return { sessions: [{ id: "row-1", session_id: "chat-1" }] };
        return null;
      });
      const summary = await bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client });
      expect(summary.skipped).toBe(false);
      expect(fake.calls[0]?.path).toBe("/api/v1/me/sessions?limit=200&offset=0");
    }
  });

  it("getSettings rejection → skip settings-error, no throw, zero HTTP", async () => {
    const store = makeBulkTestStore({ reject: new Error("db down") });
    const fake = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["chat-1"], { http: fake.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "settings-error" });
    expect(fake.calls).toHaveLength(0);
  });

  it("empty / blank-only ids → skip no-sessions (with resolvable credentials), zero HTTP", async () => {
    const store = makeBulkTestStore({ ...STASH_SETTINGS, stashApiKey: "sk-explicit" });
    const fake = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, [], { http: fake.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "no-sessions" });
    expect(fake.calls).toHaveLength(0);
    const blanks = makeFakeHttp();
    await expect(
      bulkDeleteStashChatSessions(store as StashBulkDeleteStore, ["", "  "], { http: blanks.client }),
    ).resolves.toEqual({ skipped: true, skipReason: "no-sessions" });
    expect(blanks.calls).toHaveLength(0);
  });
});
