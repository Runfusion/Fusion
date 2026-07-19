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

/*
 * FNXC:GitLabTrackingComments 2026-07-15-10:05:
 * Parity coverage for the issue #1916 release lines on the GitLab surface.
 */
describe("formatGitLabTrackingComment release version lines", () => {
  function selfRepoTask(overrides: Record<string, unknown> = {}): any {
    return { ...task("project_issue"), branch: "fusion/fn-1", mergeDetails: { commitSha: "abcdef123", mergedAt: "today" }, ...overrides };
  }

  it("appends release lines when the linked project path is the Fusion self-repo", () => {
    const comment = formatGitLabTrackingComment(selfRepoTask(), "done", undefined, { repository: "runfusion/fusion", currentVersion: "0.60.0" });
    expect(comment).toContain("Current version: v0.60.0");
    expect(comment).toContain("Target release: v0.61.0");
  });

  it("matches the self-repo project path case-insensitively", () => {
    const comment = formatGitLabTrackingComment(selfRepoTask(), "done", undefined, { repository: "Runfusion/Fusion", currentVersion: "0.60.0" });
    expect(comment).toContain("Target release: v0.61.0");
  });

  it("leaves done comments on every other project byte-for-byte unchanged", () => {
    const withVersion = formatGitLabTrackingComment(selfRepoTask(), "done", undefined, { repository: "g/p", currentVersion: "0.60.0" });
    expect(withVersion).not.toContain("Target release");
    expect(withVersion).toBe(formatGitLabTrackingComment(selfRepoTask(), "done"));
  });

  it("omits release lines on the in-progress transition", () => {
    expect(formatGitLabTrackingComment(selfRepoTask(), "in-progress", undefined, { repository: "runfusion/fusion", currentVersion: "0.60.0" })).not.toContain("Target release");
  });

  it("falls back silently for the unresolved sentinel and unparseable versions", () => {
    for (const currentVersion of ["0.0.0", "not-a-version"]) {
      const comment = formatGitLabTrackingComment(selfRepoTask(), "done", undefined, { repository: "runfusion/fusion", currentVersion });
      expect(comment).not.toContain("Target release");
      expect(comment).toContain("✅ Done —");
    }
  });

  it("never resolves the package version for non-self projects", () => {
    const resolveVersion = vi.fn(() => "0.60.0");
    formatGitLabTrackingComment(selfRepoTask(), "done", undefined, { repository: "g/p", currentVersion: resolveVersion });
    expect(resolveVersion).not.toHaveBeenCalled();
  });

  it("keeps release lines within the length cap when the title forces truncation", () => {
    const comment = formatGitLabTrackingComment(selfRepoTask({ title: "T".repeat(4000) }), "done", "https://gitlab.example.com/g/p/-/issues/5", { repository: "runfusion/fusion", currentVersion: "0.60.0" });
    expect(comment.length).toBeLessThanOrEqual(2000);
    expect(comment).toContain("Target release: v0.61.0");
  });

  /*
   * FNXC:GitLabTrackingComments 2026-07-15-10:05:
   * resolveGitLabTargetFromItem() prefers the numeric projectId over projectPath, so passing the
   * resolved target.project would stringify an id ("12345") and never match the self-repo slug.
   * The service passes item.projectPath; assert the posted body proves that wiring.
   */
  it("posts release lines using the project path even when a numeric projectId is present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 })); vi.stubGlobal("fetch", fetchImpl);
    const s = store();
    new GitLabTrackingCommentService(s as any).start();
    const tracked = task("project_issue");
    tracked.gitlabTracking.item.projectPath = "runfusion/fusion";
    tracked.gitlabTracking.item.projectId = 12345;
    s.emit("task:moved", { task: tracked, from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body)).body as string;
    expect(body).toContain("Target release: v");
    expect(body).toContain("Current version: v");
  });

  it("posts no release lines for any other linked project", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 })); vi.stubGlobal("fetch", fetchImpl);
    const s = store();
    new GitLabTrackingCommentService(s as any).start();
    s.emit("task:moved", { task: task("project_issue"), from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body)).body as string;
    expect(body).toContain("✅ Done —");
    expect(body).not.toContain("Target release");
  });
});
