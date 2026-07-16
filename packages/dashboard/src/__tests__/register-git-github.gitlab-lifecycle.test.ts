// @vitest-environment node

import { EventEmitter } from "node:events";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGitGitHubRoutes } from "../routes/register-git-github.js";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function createStore() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getRootDir: vi.fn().mockReturnValue(process.cwd()),
    getFusionDir: vi.fn().mockReturnValue(`${process.cwd()}/.fusion`),
    // FNXC:PostgresCutover 2026-07-16-06:55: refresh listeners expect the
    // backend accessor even when their test double does not persist index rows.
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com", gitlabCommentOnDone: true, gitlabCloseSourceIssueOnDone: true }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    listTasks: vi.fn().mockResolvedValue([]),
    // FNXC:PostgresCutover 2026-07-16-06:55: lifecycle refresh reads the
    // current task asynchronously before deriving GitLab follow-up work.
    getTask: vi.fn().mockResolvedValue(undefined),
    listTasksForGithubTrackingReconcile: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }),
    updateTask: vi.fn().mockResolvedValue(undefined),
  });
}
function createContext(store: any, disposers: Array<() => void>) {
  return {
    router: express.Router(), store, options: {},
    getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
    getScopedStore: async () => store,
    registerDispose: (fn: () => void) => { disposers.push(fn); },
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as any;
}
const task: any = { id: "FN-1", title: "T", sourceIssue: { provider: "gitlab", repository: "g/p", issueNumber: 2, url: "url" }, gitlabTracking: { item: { kind: "project_issue", instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: "url", projectPath: "g/p", iid: 2, title: "T", state: "opened", linkedAt: "now" } } };

describe("registerGitGitHubRoutes GitLab lifecycle services", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setImmediate"] }));
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("starts GitLab lifecycle listeners and dispose removes them", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 2 }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "opened", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "closed", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "closed", labels: [] }));
    vi.stubGlobal("fetch", fetchImpl);
    const store = createStore(); const disposers: Array<() => void> = [];
    registerGitGitHubRoutes(createContext(store, disposers));
    store.emit("task:moved", { task, from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    // FNXC:GitLabIssueComments 2026-07-16-07:25: an imported GitLab task can
    // carry both source and tracking links to one issue; its done transition
    // must produce exactly one comment, with tracking owning the richer payload.
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/notes"))).toHaveLength(1);
    for (const dispose of disposers) dispose();
    store.emit("task:moved", { task, from: "done", to: "todo" });
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
