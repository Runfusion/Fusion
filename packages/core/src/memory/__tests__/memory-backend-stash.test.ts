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
import { beforeEach, describe, expect, it } from "vitest";
import {
  StashMemoryBackend,
  __resetStashFolderCacheForTests,
  normalizeStashSearchQuery,
  queryStashEvents,
  deleteStashChatSession,
  type StashHttpClient,
} from "../memory-backend-stash.js";

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

describe("deleteStashChatSession (RUFU-121 Step 2)", () => {
  it("soft-deletes the Stash session row matching session_id (two-step lookup)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions?limit=200") {
        return { sessions: [{ id: "row-1", session_id: "chat-ses-1" }, { id: "row-2", session_id: "other" }] };
      }
      if (path === "/api/v1/me/sessions/row-1") return null; // 204
      return null;
    });
    const result = await deleteStashChatSession("http://stash.test", "k", "chat-ses-1", fake.client);
    expect(result).toEqual({ deleted: true, status: "ok" });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me/sessions?limit=200",
      "DELETE /api/v1/me/sessions/row-1",
    ]);
  });

  it("accepts a numeric row id", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions?limit=200") return { sessions: [{ id: 42, session_id: "s" }] };
      return null;
    });
    const result = await deleteStashChatSession("http://stash.test", "k", "s", fake.client);
    expect(result).toEqual({ deleted: true, status: "ok" });
    expect(fake.calls[1].path).toBe("/api/v1/me/sessions/42");
  });

  it("resolves not-found when no session row matches (no DELETE issued)", async () => {
    const fake = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions?limit=200") return { sessions: [{ id: "row-1", session_id: "other" }] };
      return null;
    });
    const result = await deleteStashChatSession("http://stash.test", "k", "missing", fake.client);
    expect(result).toEqual({ deleted: false, status: "not-found" });
    expect(fake.calls).toHaveLength(1);
  });

  it("resolves not-found on a 404 and skipped on other errors — never throws", async () => {
    const fake404 = makeFakeHttp(() => { throw new Error("Stash returned 404: Not Found"); });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fake404.client)).resolves.toEqual({
      deleted: false,
      status: "not-found",
    });
    const fake500 = makeFakeHttp(() => { throw new Error("network down"); });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fake500.client)).resolves.toEqual({
      deleted: false,
      status: "skipped",
    });
    // DELETE-side failure (after a found row) is also a skip, not a throw.
    const fakeDeleteFail = makeFakeHttp((path) => {
      if (path === "/api/v1/me/sessions?limit=200") return { sessions: [{ id: "row-1", session_id: "s" }] };
      throw new Error("Stash returned 500: Internal");
    });
    await expect(deleteStashChatSession("http://stash.test", "k", "s", fakeDeleteFail.client)).resolves.toEqual({
      deleted: false,
      status: "skipped",
    });
  });
});
