import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ExternalSessionReader, ExternalSessionSummaryStore } from "@fusion/core";
import type { ApiRoutesContext } from "../types.js";
import { registerExternalSessionRoutes } from "../register-external-session-routes.js";

/*
FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
The route-level contract for session summaries. The invariant under test is the one that matters during an
inference outage: a failed regeneration must leave the previous summary intact and still visible, and must say
that the attempt failed rather than reporting success or an empty pane.
*/
const summarize = vi.hoisted(() => vi.fn());
vi.mock("@fusion/core", async importOriginal => ({ ...(await importOriginal<object>()), summarizeExternalSession: summarize }));

const id = "a".repeat(64);
type Handler = (req: Request, res: Response) => Promise<void>;

function setup() {
  const gets = new Map<string, Handler>();
  const posts = new Map<string, Handler>();
  const getProjectContext = vi.fn(async () => ({ projectId: "project-a", store: {
    getAsyncLayer: () => ({ projectId: "project-a" }),
    getGlobalSettingsStore: () => ({ getSettings: async () => ({}) }),
    getSettings: async () => ({}),
    getRootDir: () => "/repo",
  } }));
  registerExternalSessionRoutes({
    router: { get: (p: string, h: Handler) => gets.set(p, h), post: (p: string, h: Handler) => posts.set(p, h) },
    getProjectContext, options: {},
  } as unknown as ApiRoutesContext);
  const req = { query: { projectId: "project-a" }, params: { id }, headers: {}, body: {} } as unknown as Request;
  const json = vi.fn(); const status = vi.fn(); const res = { json, status } as unknown as Response;
  status.mockReturnValue(res);
  return { gets, posts, req, res, json, status };
}

const session = { id, hostId: "host-a", provider: "codex" } as never;
const turn = { nativeTurnId: "t0", revision: 1, ordinal: 0, prompts: [{ at: null, text: "Fix the parser" }],
  response: "Fixed it", fileChanges: [] } as never;

beforeEach(() => { vi.restoreAllMocks(); summarize.mockReset(); });

describe("external session summary route", () => {
  it("stores a generated summary with the turn range it actually covered", async () => {
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(session);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "tail").mockResolvedValue([turn]);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "latestOrdinal").mockResolvedValue(0);
    const record = vi.spyOn(ExternalSessionSummaryStore.prototype, "recordSuccess").mockResolvedValue({} as never);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "read").mockResolvedValue({ sessionId: id, summary: "Fixed the parser.",
      provider: null, model: null, throughOrdinal: 0, turnCount: 1, generatedAt: "2026-09-24T00:00:00.000Z",
      status: "ready", failure: null, attemptedAt: "2026-09-24T00:00:00.000Z" });
    summarize.mockResolvedValue("Fixed the parser.");
    const s = setup();
    await s.posts.get("/external-sessions/:id/summary")!(s.req, s.res);
    expect(record).toHaveBeenCalledWith(id, expect.objectContaining({ summary: "Fixed the parser.",
      coverage: { throughOrdinal: 0, turnCount: 1 } }));
    // The transcript is what reached the model; the prompt text must be in it.
    expect(summarize.mock.calls[0]![0]).toContain("Fix the parser");
    expect(s.json.mock.calls[0]![0]).toMatchObject({ stale: false, summary: { status: "ready" } });
    expect(s.status).not.toHaveBeenCalled();
  });

  it("keeps the previous summary when generation fails, and reports the failure", async () => {
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(session);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "tail").mockResolvedValue([turn]);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "latestOrdinal").mockResolvedValue(3);
    const success = vi.spyOn(ExternalSessionSummaryStore.prototype, "recordSuccess");
    const failure = vi.spyOn(ExternalSessionSummaryStore.prototype, "recordFailure").mockResolvedValue({} as never);
    // What the store answers after the failure: the older summary is still there.
    vi.spyOn(ExternalSessionSummaryStore.prototype, "read").mockResolvedValue({ sessionId: id, summary: "An earlier summary.",
      provider: null, model: null, throughOrdinal: 0, turnCount: 1, generatedAt: "2026-09-24T00:00:00.000Z",
      status: "failed", failure: "AI engine not available", attemptedAt: "2026-09-24T02:00:00.000Z" });
    summarize.mockRejectedValue(new Error("AI engine not available"));
    const s = setup();
    await s.posts.get("/external-sessions/:id/summary")!(s.req, s.res);
    expect(failure).toHaveBeenCalledWith(id, "AI engine not available");
    expect(success).not.toHaveBeenCalled();
    expect(s.status).toHaveBeenCalledWith(502);
    const body = s.json.mock.calls[0]![0];
    expect(body.summary.summary).toBe("An earlier summary.");
    expect(body.summary.status).toBe("failed");
    // Staleness stays derived from the session's real turns, so the preserved summary is not read as current.
    expect(body).toMatchObject({ stale: true, turnsSince: 3 });
  });

  it("records a failure rather than storing an empty summary when the model returns nothing", async () => {
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(session);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "tail").mockResolvedValue([turn]);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "latestOrdinal").mockResolvedValue(0);
    const success = vi.spyOn(ExternalSessionSummaryStore.prototype, "recordSuccess");
    const failure = vi.spyOn(ExternalSessionSummaryStore.prototype, "recordFailure").mockResolvedValue({} as never);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "read").mockResolvedValue(null);
    summarize.mockResolvedValue(null);
    const s = setup();
    await s.posts.get("/external-sessions/:id/summary")!(s.req, s.res);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalled();
    expect(s.status).toHaveBeenCalledWith(502);
  });

  it("refuses to summarize a session with no collected turns instead of prompting on an empty transcript", async () => {
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(session);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "tail").mockResolvedValue([]);
    const s = setup();
    await expect(s.posts.get("/external-sessions/:id/summary")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 409 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("refuses an unknown session and an invalid id", async () => {
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(null);
    const s = setup();
    await expect(s.posts.get("/external-sessions/:id/summary")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 404 });
    (s.req.params as Record<string, string>).id = "not-an-id";
    await expect(s.posts.get("/external-sessions/:id/summary")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
    await expect(s.gets.get("/external-sessions/:id/summary")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("never generates on a read, so opening a session spends no model budget", async () => {
    vi.spyOn(ExternalSessionSummaryStore.prototype, "read").mockResolvedValue(null);
    vi.spyOn(ExternalSessionSummaryStore.prototype, "latestOrdinal").mockResolvedValue(4);
    const s = setup();
    await s.gets.get("/external-sessions/:id/summary")!(s.req, s.res);
    expect(summarize).not.toHaveBeenCalled();
    // With no stored summary there is nothing to be stale against.
    expect(s.json).toHaveBeenCalledWith({ schemaVersion: 1, summary: null, stale: false, turnsSince: 0 });
  });
});

/*
FNXC:ExternalSessionAttribution 2026-09-24-07:05 (operator decision F4 = 1): the read surfaces must carry
whether a collected session IS a Fusion task run, because that is what stops its cost being counted twice.
*/
describe("external session attribution on the read surfaces", () => {
  const listed = { id, hostId: "host-a", provider: "codex", nativeSessionId: "native-abc", revision: 1,
    observation: { provider: "codex", nativeSessionId: "native-abc", revision: 1, activity: "working",
      observedAt: new Date().toISOString() }, receivedAt: new Date().toISOString(), lastHeartbeatAt: null,
    collectorConnected: true, activityStale: false } as never;

  it("marks a listed session that is a Fusion task run", async () => {
    const { ExternalSessionAttribution } = await import("@fusion/core");
    vi.spyOn(ExternalSessionReader.prototype, "list").mockResolvedValue({ schemaVersion: 1, sessions: [listed], nextCursor: null });
    const resolve = vi.spyOn(ExternalSessionAttribution.prototype, "resolve")
      .mockResolvedValue(new Map([[id, { taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false }]]));
    const s = setup();
    await s.gets.get("/external-sessions")!(s.req, s.res);
    expect(resolve).toHaveBeenCalledWith([{ sessionId: id, provider: "codex", nativeSessionId: "native-abc" }]);
    expect(s.json.mock.calls[0]![0].sessions[0].fusion).toEqual({ taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false });
  });

  it("leaves a session unattributed when reconciliation is unavailable, rather than guessing", async () => {
    const { ExternalSessionAttribution } = await import("@fusion/core");
    vi.spyOn(ExternalSessionReader.prototype, "list").mockResolvedValue({ schemaVersion: 1, sessions: [listed], nextCursor: null });
    vi.spyOn(ExternalSessionAttribution.prototype, "resolve").mockRejectedValue(new Error("storage unavailable"));
    const s = setup();
    await s.gets.get("/external-sessions")!(s.req, s.res);
    // Unattributed is the safe reading: it never suppresses a cost that might be Fusion's own.
    expect(s.json.mock.calls[0]![0].sessions[0].fusion).toBeNull();
  });

  it("carries attribution on the session detail too, so the two surfaces cannot disagree", async () => {
    const { ExternalSessionAttribution } = await import("@fusion/core");
    vi.spyOn(ExternalSessionReader.prototype, "get").mockResolvedValue(listed);
    vi.spyOn(ExternalSessionAttribution.prototype, "resolve")
      .mockResolvedValue(new Map([[id, { taskId: null, cliSessionId: null, ambiguous: true }]]));
    const s = setup();
    await s.gets.get("/external-sessions/:id")!(s.req, s.res);
    expect(s.json.mock.calls[0]![0].fusion).toEqual({ taskId: null, cliSessionId: null, ambiguous: true });
  });
});

/*
FNXC:ExternalSessionOverview 2026-09-24-08:12: the range aggregate. It must be registered ahead of "/:id", must
reject a malformed filter, and must reuse the bounded session scan rather than walking the table.
*/
describe("external session cost overview route", () => {
  it("aggregates the bounded session scan and carries the Fusion-run split", async () => {
    const { ExternalSessionRankings, ExternalSessionAttribution } = await import("@fusion/core");
    const band = { model: "gpt-5.6-sol", inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0,
      cacheWriteHourTokens: 0, outputTokens: 100_000, reasoningTokens: null, fast: false, longContext: false };
    const sessions = vi.spyOn(ExternalSessionRankings.prototype, "sessions").mockResolvedValue({
      candidates: [{ sessionId: id, hostId: "m3", provider: "codex", title: null, nativeSessionId: "native-1",
        observedAt: "2026-09-20T10:00:00.000Z", usage: [band], usageComplete: true }],
      scanned: 1, truncated: false, withoutUsage: 0 });
    vi.spyOn(ExternalSessionAttribution.prototype, "resolve")
      .mockResolvedValue(new Map([[id, { taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false }]]));
    const s = setup();
    s.req.query = { projectId: "project-a", from: "2026-09-01T00:00:00.000Z", hostId: "m3" };
    await s.gets.get("/external-sessions/overview")!(s.req, s.res);
    expect(sessions).toHaveBeenCalledWith({ from: "2026-09-01T00:00:00.000Z", hostId: "m3" });
    const body = s.json.mock.calls[0]![0];
    expect(body.totalUsd).toBeGreaterThan(0);
    expect(body.byDay).toEqual([expect.objectContaining({ key: "2026-09-20", sessions: 1 })]);
    // The split equals the whole total here because the only session is a Fusion run.
    expect(body.fusionAttributed).toMatchObject({ sessions: 1, ambiguous: 0 });
    expect(body.fusionAttributed.usd).toBeCloseTo(body.totalUsd, 10);
  });

  it("still answers when reconciliation is unavailable, attributing nothing", async () => {
    const { ExternalSessionRankings, ExternalSessionAttribution } = await import("@fusion/core");
    vi.spyOn(ExternalSessionRankings.prototype, "sessions").mockResolvedValue({
      candidates: [], scanned: 0, truncated: false, withoutUsage: 0 });
    vi.spyOn(ExternalSessionAttribution.prototype, "resolve").mockRejectedValue(new Error("storage unavailable"));
    const s = setup();
    await s.gets.get("/external-sessions/overview")!(s.req, s.res);
    expect(s.json.mock.calls[0]![0].fusionAttributed).toEqual({ sessions: 0, usd: 0, ambiguous: 0 });
  });

  it("rejects a malformed filter rather than silently widening the range", async () => {
    const s = setup();
    s.req.query = { projectId: "project-a", from: ["a", "b"] };
    await expect(s.gets.get("/external-sessions/overview")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an out-of-range date rather than scanning everything", async () => {
    const s = setup();
    s.req.query = { projectId: "project-a", from: "not-a-date" };
    await expect(s.gets.get("/external-sessions/overview")!(s.req, s.res)).rejects.toMatchObject({ statusCode: 400 });
  });
});
