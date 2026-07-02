import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabSourceIssueCloseService } from "../gitlab-source-issue-close.js";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function store(settings: any = {}) { const emitter = new EventEmitter(); return Object.assign(emitter, { getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com", gitlabCloseSourceIssueOnDone: true, ...settings }), getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }), logEntry: vi.fn() }); }
function task(kind: "project_issue" | "merge_request" = "project_issue"): any { return { id: "FN-1", sourceIssue: { provider: "gitlab", repository: "g/p", issueNumber: 2, url: "url" }, gitlabTracking: { item: { kind, instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: "url", projectPath: "g/p", iid: 2, title: "T", state: "opened", linkedAt: "now" } } }; }

describe("GitLabSourceIssueCloseService", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("honors the close-source setting for GitLab issues", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "opened", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "closed", labels: [] }));
    vi.stubGlobal("fetch", fetchImpl); const s = store(); new GitLabSourceIssueCloseService(s as any).start();
    s.emit("task:moved", { task: task(), from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Closed linked GitLab source issue", "g/p#2");
  });
  it("skips when disabled or non-GitLab", async () => {
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    const disabled = store({ gitlabCloseSourceIssueOnDone: false }); new GitLabSourceIssueCloseService(disabled as any).start();
    disabled.emit("task:moved", { task: task(), from: "todo", to: "done" });
    const s = store(); new GitLabSourceIssueCloseService(s as any).start();
    s.emit("task:moved", { task: { ...task(), sourceIssue: { provider: "github" } }, from: "todo", to: "done" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
