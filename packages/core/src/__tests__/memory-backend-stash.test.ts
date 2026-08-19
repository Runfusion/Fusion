import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  StashMemoryBackend,
  DEFAULT_STASH_URL,
} from "../memory/memory-backend-stash.js";
import type { MemorySearchOptions } from "../memory/memory-backend.js";

/**
 * RUFU-026 unit tests for the Stash memory backend.
 *
 * FNXC:StashTests 2026-08-05-16:06:
 * These tests run WITHOUT any live Stash server. They mock node:http.request
 * to exercise: search result mapping, fail-closed behavior (stash down -> []),
 * read() fail-closed, capture no-op when unreachable, and capture idempotency
 * (the REST batch endpoint is idempotent via tuple upsert, and capture() never
 * throws so a retry on an unreachable server is a no-op that does not block).
 * Cross-project isolation is a server-side (SQL-scoped) contract enforced by
 * Stash's search_scope_events (owner_user_id IN accessible_scope_ids_sql(1));
 * the client tags each uploaded event with a per-project discriminator for
 * provenance, and we assert that discriminator tagging keeps project A and
 * project B apart on a shared backend instance (no in-memory filter relied on).
 */

type MockResponse = { statusCode: number; body: unknown };
type RequestLog = {
  path: string;
  method: string;
  body?: string;
  headers: http.OutgoingHttpHeaders;
};

let responder: (opts: http.RequestOptions, body?: string) => MockResponse | Promise<MockResponse>;
let log: RequestLog[] = [];

/** Minimal fake IncomingMessage exposing statusCode + data/end events. */
function fakeIncoming(statusCode: number, body: unknown): http.IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const data = typeof body === "string" ? body : JSON.stringify(body);
  const incoming = {
    statusCode,
    setEncoding: () => {},
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return incoming;
    },
    headers: {},
  } as unknown as http.IncomingMessage;
  // Deliver chunks then end, mimicking a real response stream.
  setImmediate(() => {
    const dataCbs = listeners["data"] ?? [];
    const endCbs = listeners["end"] ?? [];
    // Send the whole body as a single chunk.
    dataCbs.forEach((cb) => cb(Buffer.from(data, "utf-8")));
    endCbs.forEach((cb) => cb());
  });
  return incoming;
}

/** Minimal fake ClientRequest exposing write/end/on. */
function fakeRequest(): http.ClientRequest {
  let body = "";
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    write(chunk: string | Buffer) {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const last = log[log.length - 1];
      if (last) last.body = body;
      return req;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return req;
    },
    emit(event: string, arg?: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
      return true;
    },
    destroy() {},
  } as unknown as http.ClientRequest;
  // Attach the real-vs-error delivery path via the request callback.
  return req;
}

let pendingRequest: {
  options: http.RequestOptions;
  cb?: (res: http.IncomingMessage) => void;
  req: http.ClientRequest;
} | null = null;

function mockHttpRequest() {
  vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    log.push({
      path: options.path ?? "",
      method: options.method ?? "GET",
      headers: options.headers ?? {},
    });
    const req = fakeRequest();
    pendingRequest = { options, cb, req };
    return req;
  }) as unknown as typeof http.request);
}

async function deliver(): Promise<void> {
  if (!pendingRequest) return;
  const { options, cb, req } = pendingRequest;
  pendingRequest = null;
  const last = log[log.length - 1];
  const body = last?.body;
  let mock: MockResponse;
  try {
    mock = await responder(options, body);
  } catch (e) {
    // Network-style error: emit on the request so the backend's req.on("error")
    // path rejects (mimics ECONNREFUSED), which its fail-closed wrappers swallow.
    (req as unknown as { emit: (event: string, arg?: unknown) => boolean }).emit("error", e);
    return;
  }
  if (typeof cb === "function") {
    cb(fakeIncoming(mock.statusCode, mock.body));
  }
}

beforeEach(() => {
  log = [];
  pendingRequest = null;
  responder = () => ({ statusCode: 200, body: {} });
  mockHttpRequest();
});

afterEach(() => {
  vi.restoreAllMocks();
  log = [];
  pendingRequest = null;
});

function backend(baseUrl = DEFAULT_STASH_URL, apiKey = "test-key") {
  return new StashMemoryBackend({ baseUrl, apiKey });
}

describe("StashMemoryBackend", () => {
  describe("search", () => {
    it("maps GET /api/v1/me/sessions/events/search results to MemorySearchResult[]", async () => {
      responder = () => ({
        statusCode: 200,
        body: {
          results: [
            { id: 1, content: "first memory", session_id: "sess_abc" },
            { id: 2, content: "second memory", session_id: "sess_abc" },
          ],
        },
      });
      const promise = backend().search("/proj", { query: "api design", limit: 5 });
      await deliver();
      const results = await promise;
      expect(results).toHaveLength(2);
      expect(results[0].snippet).toBe("first memory");
      expect(results[0].path).toContain("sess_abc");
      expect(results[0].backend).toBe("stash");
      expect(results[1].score).toBeLessThanOrEqual(results[0].score);
      const req = log.find((r) => r.path.includes("/api/v1/me/sessions/events/search"));
      expect(req).toBeTruthy();
      /*
      FNXC:RUFU122StaleSearchExpectation 2026-08-19-04:40:
      RUFU-122: this expectation predates RUFU-121's query normalization and was
      left stale on the RUFU-121 branch (red on its own HEAD — verified by
      stashing RUFU-122's changes and re-running at d52ecfdba). RUFU-121's
      normalizeStashSearchQuery intentionally keeps only the FIRST word token
      in default mode (websearch_to_tsquery safety; see its
      FNXC:RUFU121QueryNormalization note), so "api design" sends q=api.
      */
      expect(req!.path).toContain("q=api&limit=5");
      expect(req!.method).toBe("GET");
      expect(String(req!.headers.Authorization)).toBe("Bearer test-key");
    });

    it("uses the events[] key when results[] is absent", async () => {
      responder = () => ({ statusCode: 200, body: { events: [{ content: "from events key", session_id: "s1" }] } });
      const promise = backend().search("/proj", { query: "x" });
      await deliver();
      const results = await promise;
      expect(results[0].snippet).toBe("from events key");
    });

    it("fails closed to [] when stash returns an error status", async () => {
      responder = () => ({ statusCode: 500, body: { error: "boom" } });
      const promise = backend().search("/proj", { query: "x" });
      await deliver();
      expect(await promise).toEqual([]);
    });

    it("fails closed to [] when stash is unreachable (network error)", async () => {
      responder = () => { throw new Error("ECONNREFUSED"); };
      const promise = backend().search("/proj", { query: "x" });
      await deliver();
      expect(await promise).toEqual([]);
    });

    it("fails closed to [] on malformed JSON", async () => {
      responder = () => ({ statusCode: 200, body: "<html>not json</html>" });
      const promise = backend().search("/proj", { query: "x" });
      await deliver();
      expect(await promise).toEqual([]);
    });
  });

  describe("read", () => {
    it("returns {content:'',exists:false} when stash has no results", async () => {
      responder = () => ({ statusCode: 200, body: { results: [] } });
      const promise = backend().read("/proj");
      await deliver();
      const r = await promise;
      expect(r.exists).toBe(false);
      expect(r.content).toBe("");
      expect(r.backend).toBe("stash");
    });

    it("returns markdown summary when results exist", async () => {
      responder = () => ({ statusCode: 200, body: { results: [{ content: "hello", session_id: "s1" }] } });
      const promise = backend().read("/proj");
      await deliver();
      const r = await promise;
      expect(r.exists).toBe(true);
      expect(r.content).toContain("Stash Memory");
      expect(r.content).toContain("hello");
    });

    it("fails closed (content:'',exists:false) when stash is down", async () => {
      responder = () => { throw new Error("ECONNREFUSED"); };
      const promise = backend().read("/proj");
      await deliver();
      const r = await promise;
      expect(r.exists).toBe(false);
      expect(r.content).toBe("");
    });
  });

  describe("get", () => {
    it("fails closed to an empty result", async () => {
      const r = await backend().get("/proj", { path: "some/path", startLine: 1, lineCount: 10 });
      expect(r.content).toBe("");
      expect(r.totalLines).toBe(0);
      expect(r.backend).toBe("stash");
    });
  });

  describe("exists", () => {
    it("returns true when stash reachable", async () => {
      responder = () => ({ statusCode: 200, body: { results: [] } });
      const promise = backend().exists("/proj");
      await deliver();
      expect(await promise).toBe(true);
    });

    it("returns false when stash is unreachable (never throws)", async () => {
      responder = () => { throw new Error("ECONNREFUSED"); };
      const promise = backend().exists("/proj");
      await deliver();
      expect(await promise).toBe(false);
    });
  });

  describe("capture", () => {
    it("posts events to /api/v1/me/sessions/events/batch with a per-project discriminator", async () => {
      responder = () => ({ statusCode: 200, body: { inserted: 3, deduped: 0 } });
      const promise = backend().capture(
        "fusion-123-abc",
        [{ event_type: "message", content: "turn 1", agent_name: "audit" }],
        { taskId: "123", projectRoot: "/repos/projectA" },
      );
      await deliver();
      const res = await promise;
      expect(res.ok).toBe(true);
      expect(res.inserted).toBe(3);
      const req = log.find((r) => r.path.includes("/api/v1/me/sessions/events/batch"));
      expect(req).toBeTruthy();
      expect(req!.method).toBe("POST");
      const payload = JSON.parse(req!.body ?? "{}");
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].event_type).toBe("message");
      expect(payload.events[0].metadata.discriminator).toContain("projectA");
      expect(payload.events[0].metadata.session_id).toBe("fusion-123-abc");
      expect(payload.events[0].metadata.task_id).toBe("123");
      // FNXC:StashEventShape 2026-08-07-10:39: stash requires top-level
      // agent_name + session_id on every event or it returns 422. Keep both
      // surfaced at the top level, not merely inside metadata.
      expect(payload.events[0].agent_name).toBe("audit");
      expect(payload.events[0].session_id).toBe("fusion-123-abc");
      expect(String(req!.headers.Authorization)).toBe("Bearer test-key");
    });

    it("never throws when stash is unreachable (no-op, does not block a run)", async () => {
      responder = () => { throw new Error("ECONNREFUSED"); };
      const promise = backend().capture("fusion-1-a", [{ event_type: "message", content: "x" }]);
      await deliver();
      const res = await promise;
      expect(res.ok).toBe(false);
      expect(res.inserted).toBe(0);
    });

    it("is idempotent: retries resolve without throwing", async () => {
      responder = () => { throw new Error("ECONNREFUSED"); };
      const b = backend();
      const p1 = b.capture("fusion-9-z", [{ event_type: "message", content: "x" }]);
      await deliver();
      const first = await p1;
      expect(first.ok).toBe(false);
      // A second attempt (e.g. a session-end retry) also resolves without throwing.
      responder = () => ({ statusCode: 200, body: { inserted: 0, deduped: 0 } });
      const p2 = b.capture("fusion-9-z", [{ event_type: "message", content: "x" }]);
      await deliver();
      const second = await p2;
      expect(second.ok).toBe(true);
    });

    it("does not throw when the response is non-JSON", async () => {
      responder = () => ({ statusCode: 200, body: "ok" });
      const promise = backend().capture("fusion-1-a", [{ event_type: "message", content: "x" }]);
      await deliver();
      const res = await promise;
      expect(res).toEqual({ ok: false, inserted: 0, deduped: 0 });
    });
  });

  describe("write", () => {
    it("surfaces top-level agent_name + session_id so stash does not return 422", async () => {
      responder = () => ({ statusCode: 200, body: [] });
      const b = backend();
      const promise = b.write("/repos/projectA", "note content");
      await deliver();
      const res = await promise;
      expect(res.success).toBe(true);
      const req = log.find((r) => r.path.includes("/api/v1/me/sessions/events/batch"));
      expect(req).toBeTruthy();
      const payload = JSON.parse(req!.body ?? "{}");
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].agent_name).toBe("fusion");
      expect(payload.events[0].session_id).toMatch(/^fusion-/);
      expect(payload.events[0].metadata.discriminator).toBeDefined();
      expect(String(req!.headers.Authorization)).toBe("Bearer test-key");
    });
  });

  describe("A/B isolation intent", () => {
    it("tags project A and project B events with distinct discriminators (server-side SQL isolation, no in-memory filter relied upon)", async () => {
      const posted: string[] = [];
      responder = (opts, body) => {
        if (opts.path?.includes("/events/batch")) posted.push(body ?? "");
        return { statusCode: 200, body: { inserted: 1, deduped: 0 } };
      };
      const b = backend();
      const pa = b.capture("fusion-1-a", [{ event_type: "msg", content: "A secret" }], { taskId: "1", projectRoot: "/repos/projectA" });
      await deliver();
      await pa;
      const pb = b.capture("fusion-2-b", [{ event_type: "msg", content: "B secret" }], { taskId: "2", projectRoot: "/repos/projectB" });
      await deliver();
      await pb;
      expect(posted).toHaveLength(2);
      const da = JSON.parse(posted[0]).events[0].metadata.discriminator;
      const db = JSON.parse(posted[1]).events[0].metadata.discriminator;
      expect(da).toContain("projectA");
      expect(db).toContain("projectB");
      expect(da).not.toBe(db);
      // Search for project A must not surface project B's content.
      responder = () => ({
        statusCode: 200,
        body: { results: [{ content: "A secret", session_id: "fusion-1-a", metadata: { discriminator: da } }] },
      });
      const ps = b.search("/repos/projectA", { query: "secret" } satisfies MemorySearchOptions);
      await deliver();
      const results = await ps;
      expect(results.every((r) => !r.snippet.includes("B secret"))).toBe(true);
    });
  });

  describe("captureMemory helper (capture seam gating)", () => {
    it("no-ops when memoryEnabled is false", async () => {
      const { captureMemory } = await import("../memory/memory-backend.js");
      let called = false;
      responder = () => { called = true; return { statusCode: 200, body: {} }; };
      const res = await captureMemory(
        "/proj",
        { memoryEnabled: false, memoryBackendType: "stash" },
        "fusion-1-a",
        [{ event_type: "message", content: "x" }],
      );
      expect(called).toBe(false);
      expect(res).toEqual({ ok: false, inserted: 0, deduped: 0 });
    });

    it("no-ops when the backend does not implement the capture seam (never throws)", async () => {
      const { captureMemory } = await import("../memory/memory-backend.js");
      const res = await captureMemory(
        "/proj",
        { memoryEnabled: true, memoryBackendType: "qmd" },
        "fusion-1-a",
        [{ event_type: "message", content: "x" }],
      );
      expect(res.ok).toBe(false);
    });

    it("no-ops on empty events", async () => {
      const { captureMemory } = await import("../memory/memory-backend.js");
      let called = false;
      responder = () => { called = true; return { statusCode: 200, body: { inserted: 1, deduped: 0 } }; };
      const res = await captureMemory(
        "/proj",
        { memoryEnabled: true, memoryBackendType: "stash" },
        "fusion-1-a",
        [],
      );
      expect(called).toBe(false);
      expect(res.ok).toBe(false);
    });

    it("captures through the resolved stash backend and never throws when unreachable", async () => {
      const { captureMemory } = await import("../memory/memory-backend.js");
      responder = () => ({ statusCode: 200, body: { inserted: 2, deduped: 0 } });
      const p1 = captureMemory(
        "/repos/projectA",
        { memoryEnabled: true, memoryBackendType: "stash", stashUrl: DEFAULT_STASH_URL, stashApiKey: "k" },
        "fusion-9-z",
        [{ event_type: "note", content: "captured" }],
        { taskId: "9" },
      );
      await deliver();
      const res = await p1;
      expect(res.ok).toBe(true);
      expect(res.inserted).toBe(2);

      // Now unreachable: must resolve ok:false, not throw or block.
      responder = () => { throw new Error("ECONNREFUSED"); };
      const p2 = captureMemory(
        "/repos/projectA",
        { memoryEnabled: true, memoryBackendType: "stash", stashUrl: DEFAULT_STASH_URL, stashApiKey: "k" },
        "fusion-9-z",
        [{ event_type: "note", content: "captured" }],
        { taskId: "9" },
      );
      await deliver();
      const fail = await p2;
      expect(fail.ok).toBe(false);
    });
  });

  /*
  FNXC:RUFU122ChunkedUpload 2026-08-19-04:30:
  RUFU-122 Step 2: capture() uploads in sequential 100-event chunks (Stash's
  verified per-POST cap). 250 events -> 3 POSTs (100+100+50); a mid-stream
  chunk failure returns the partial leading-chunk counts with ok:false and
  never throws; an empty list issues no POST; the under-cap path stays a
  single POST (byte-identical wire contract to the pre-RUFU-122 single-upload).
  */
  describe("capture chunked upload (RUFU-122)", () => {
    const batchEventsIn = (body: string | undefined): number =>
      body ? (JSON.parse(body) as { events: unknown[] }).events.length : 0;

    const transcriptEvents = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ event_type: "text", content: `${prefix}-${i}` }));

    /*
    fakeIncoming delivers its data/end events via setImmediate, so a
    deliver() returns BEFORE the response reaches the backend's promise. For
    sequential chunk uploads the next POST is only issued once the previous
    response lands, so each deliver() must be followed by one macrotask wait
    before the next deliver().
    */
    const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

    it("250 events -> 3 sequential POSTs (100+100+50) with summed counts and ok:true", async () => {
      responder = (_opts, body) => ({
        statusCode: 200,
        body: { inserted: batchEventsIn(body), deduped: 0 },
      });
      const promise = backend().capture("fusion-task-RUFU-122", transcriptEvents(250, "e"), { projectRoot: "/proj" });
      await deliver();
      await macrotask();
      await deliver();
      await macrotask();
      await deliver();
      await macrotask();
      const res = await promise;
      const batchPosts = log.filter((r) => r.path.includes("/api/v1/me/sessions/events/batch"));
      expect(batchPosts).toHaveLength(3);
      expect(batchPosts.map((r) => batchEventsIn(r.body))).toEqual([100, 100, 50]);
      expect(res).toEqual({ inserted: 250, deduped: 0, ok: true });
    });

    it("partial failure (2nd of 3 chunks fails) -> {inserted: 100, ok: false}, never throws, no 3rd POST", async () => {
      let batchPostCount = 0;
      responder = (_opts, body) => {
        batchPostCount += 1;
        if (batchPostCount === 2) {
          return { statusCode: 500, body: "internal error" };
        }
        return { statusCode: 200, body: { inserted: batchEventsIn(body), deduped: 0 } };
      };
      const promise = backend().capture("fusion-task-RUFU-122", transcriptEvents(250, "e"), { projectRoot: "/proj" });
      await deliver();
      await macrotask();
      await deliver();
      await macrotask();
      // Chunk 2 failed: capture must have stopped (no 3rd chunk in flight) and
      // resolved with the leading chunk's counts, not rejected.
      const res = await promise;
      expect(res).toEqual({ inserted: 100, deduped: 0, ok: false });
      const batchPosts = log.filter((r) => r.path.includes("/api/v1/me/sessions/events/batch"));
      expect(batchPosts).toHaveLength(2);
    });

    it("empty event list -> no POST and {0, 0, ok: true}", async () => {
      const res = await backend().capture("fusion-task-RUFU-122", [], { projectRoot: "/proj" });
      expect(res).toEqual({ inserted: 0, deduped: 0, ok: true });
      expect(log).toHaveLength(0);
    });

    it("under-cap upload (<= 100 events) stays a single POST with every event in order", async () => {
      responder = (_opts, body) => ({ statusCode: 200, body: { inserted: batchEventsIn(body), deduped: 0 } });
      const events = transcriptEvents(100, "e");
      const promise = backend().capture("fusion-task-RUFU-122", events, { projectRoot: "/proj" });
      await deliver();
      const res = await promise;
      const batchPosts = log.filter((r) => r.path.includes("/api/v1/me/sessions/events/batch"));
      expect(batchPosts).toHaveLength(1);
      const sent = (JSON.parse(batchPosts[0].body ?? "") as { events: Array<{ content: string }> }).events;
      expect(sent).toHaveLength(100);
      expect(sent[0].content).toBe("e-0");
      expect(sent[99].content).toBe("e-99");
      expect(res).toEqual({ inserted: 100, deduped: 0, ok: true });
    });
  });
});