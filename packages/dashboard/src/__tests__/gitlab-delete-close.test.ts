import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createLogger, loggerWarn } = vi.hoisted(() => {
  const loggerWarn = vi.fn();
  return {
    createLogger: vi.fn(() => ({ log: vi.fn(), debug: vi.fn(), warn: loggerWarn, error: vi.fn() })),
    loggerWarn,
  };
});

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  createLogger,
}));

import { GitLabDeleteCloseService, decideGitLabDeleteAction } from "../gitlab-delete-close.js";

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function store(logEntry = vi.fn()) {
  return Object.assign(new EventEmitter(), {
    getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com" }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    logEntry,
  });
}
function sourceTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-8687", sourceIssue: { provider: "gitlab", repository: "group/project", issueNumber: 42, url: "https://gitlab.example.com/group/project/-/issues/42" },
    source: { sourceMetadata: { resourceType: "project_issue", projectPath: "group/project", iid: 42 } }, ...overrides,
  } as any;
}
function emit(s: ReturnType<typeof store>, task = sourceTask(), meta?: any) { s.emit("task:deleted", task, meta); }
async function flush() { await new Promise((resolve) => setImmediate(resolve)); }
const opened = { iid: 42, title: "Issue", web_url: "url", state: "opened", labels: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  loggerWarn.mockClear();
});

describe("decideGitLabDeleteAction", () => {
  const issue = { kind: "project_issue" as const, project: "group/project", iid: 42, label: "group/project#42" };
  it("keeps split deletes, leave, MRs, and missing targets non-mutating", () => {
    expect(decideGitLabDeleteAction({ closureContext: { kind: "split-into-subtasks" } }, issue).reason).toBe("split-close");
    expect(decideGitLabDeleteAction({ githubIssueAction: "leave" }, issue).reason).toBe("leave");
    expect(decideGitLabDeleteAction({}, { ...issue, kind: "merge_request" }).reason).toBe("merge-request");
    expect(decideGitLabDeleteAction({}, null).reason).toBe("no-target");
  });

  it("closes auto/default issues and degrades delete to close", () => {
    expect(decideGitLabDeleteAction(undefined, issue)).toMatchObject({ action: "close", deletionUnsupported: false });
    expect(decideGitLabDeleteAction({ githubIssueAction: "auto" }, issue)).toMatchObject({ action: "close", deletionUnsupported: false });
    expect(decideGitLabDeleteAction({ githubIssueAction: "delete" }, issue)).toMatchObject({ action: "close", deletionUnsupported: true });
  });
});

describe("GitLabDeleteCloseService", () => {
  it("closes source issues once for the default delete reproduction without a note", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(opened)).mockResolvedValueOnce(response({ ...opened, state: "closed" })); vi.stubGlobal("fetch", fetch);
    const s = store(); new GitLabDeleteCloseService(s as any).start(); emit(s, sourceTask({ source: undefined }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toContain("/projects/group%2Fproject/issues/42");
    expect(fetch.mock.calls[1][0]).toContain("state_event=close");
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/notes"))).toHaveLength(0);
  });

  it("uses delete-only malformed tracking fallback to close the source once", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(opened)).mockResolvedValueOnce(response({ ...opened, state: "closed" })); vi.stubGlobal("fetch", fetch);
    const s = store(); new GitLabDeleteCloseService(s as any).start();
    emit(s, sourceTask({ gitlabTracking: { item: { kind: "project_issue", iid: 42 } } }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0][0]).toContain("group%2Fproject/issues/42");
  });

  it("does not over-fire for split deletes or merge requests", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const s = store(); new GitLabDeleteCloseService(s as any).start();
    emit(s, sourceTask(), { closureContext: { kind: "split-into-subtasks", childTaskIds: ["FN-child"] } });
    emit(s, sourceTask({ source: { sourceMetadata: { resourceType: "merge_request", projectPath: "group/project", iid: 42 } } }));
    await flush(); expect(fetch).not.toHaveBeenCalled();
  });

  it("honors leave and closes rather than hard-deleting on delete", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(opened)).mockResolvedValueOnce(response({ ...opened, state: "closed" })); vi.stubGlobal("fetch", fetch);
    const s = store(); new GitLabDeleteCloseService(s as any).start();
    emit(s, sourceTask({ id: "FN-leave" }), { githubIssueAction: "leave" }); await flush(); expect(fetch).not.toHaveBeenCalled();
    emit(s, sourceTask(), { githubIssueAction: "delete" }); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(s.logEntry).toHaveBeenCalledWith("FN-8687", "GitLab issue deletion is not supported; closed instead", "group/project#42");
  });

  it("does nothing for non-GitLab, unlinked, or already-closed issues", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...opened, state: "closed" })); vi.stubGlobal("fetch", fetch); const s = store(); new GitLabDeleteCloseService(s as any).start();
    emit(s, sourceTask({ sourceIssue: { provider: "github" } })); emit(s, { id: "FN-none" } as any); emit(s);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("retries a transient close exactly once", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response(opened)).mockResolvedValueOnce(response({ message: "temporary" }, 503)).mockResolvedValueOnce(response({ ...opened, state: "closed" })); vi.stubGlobal("fetch", fetch);
    const s = store(); new GitLabDeleteCloseService(s as any).start(); emit(s);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); vi.useRealTimers();
  });

  it("reports one structured warning without escaping or closing twice when the listener boundary fails", async () => {
    const failingLog = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    const s = store(failingLog);
    const fetch = vi.fn().mockResolvedValueOnce(response(opened)).mockResolvedValueOnce(response({ message: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetch);
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);

    new GitLabDeleteCloseService(s as any).start();
    emit(s);

    await vi.waitFor(() => expect(loggerWarn).toHaveBeenCalledTimes(1));
    await flush();
    expect(createLogger).toHaveBeenCalledWith("dashboard-gitlab-delete-close");
    expect(loggerWarn).toHaveBeenCalledWith("[gitlab-delete-close] listener failure", {
      taskId: "FN-8687",
      stage: "close",
      error: "audit unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
  });

  it("attaches idempotently and detaches all listeners on stop", async () => {
    const s = store(); const service = new GitLabDeleteCloseService(s as any); service.start(); service.attach(s as any); service.stop();
    emit(s); await flush(); expect(s.listenerCount("task:deleted")).toBe(0);
  });
});
