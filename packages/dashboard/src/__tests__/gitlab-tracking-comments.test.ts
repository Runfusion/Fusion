import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabTrackingCommentService, formatGitLabTrackingComment } from "../gitlab-tracking-comments.js";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function store() { const emitter = new EventEmitter(); return Object.assign(emitter, { getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com" }), getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }), logEntry: vi.fn() }); }
function task(kind: "project_issue" | "group_issue" | "merge_request" = "merge_request"): any { return { id: "FN-1", title: "Ship", description: "Body", gitlabTracking: { item: { kind, instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: kind === "merge_request" ? "https://gitlab.example.com/g/p/-/merge_requests/5" : "https://gitlab.example.com/g/p/-/issues/5", projectPath: "g/p", iid: 5, title: "Ship", state: "opened", linkedAt: "now" } } }; }

describe("GitLabTrackingCommentService", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("formats in-progress and done status comments", () => {
    expect(formatGitLabTrackingComment(task(), "in-progress")).toContain("🚧 In progress");
    expect(formatGitLabTrackingComment({ ...task(), branch: "fusion/FN-1", mergeDetails: { commitSha: "abcdef123", mergedAt: "today" } }, "done", "https://gitlab.example.com/g/p/-/merge_requests/5")).toContain("GitLab: https://gitlab.example.com/g/p/-/merge_requests/5");
  });
  it("posts comments to merge requests and group-backed project issues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 })); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabTrackingCommentService(s as any).start();
    s.emit("task:moved", { task: task("merge_request"), from: "todo", to: "done" });
    s.emit("task:moved", { task: task("group_issue"), from: "todo", to: "in-progress" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/5/notes");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/5/notes");
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Posted GitLab tracking comment", "g/p!5 (done)");
  });
  it("skips missing auth without calling GitLab", async () => {
    const s = store(); s.getSettings.mockResolvedValueOnce({ gitlabAuthToken: "" }); const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    new GitLabTrackingCommentService(s as any).start(); s.emit("task:moved", { task: task(), from: "todo", to: "done" });
    await vi.waitFor(() => expect(s.logEntry).toHaveBeenCalled());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
