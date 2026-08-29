import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabIssueCommentService } from "../gitlab-issue-comment.js";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function store(settings: any = {}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com", gitlabCommentOnDone: true, ...settings }),
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
    logEntry: vi.fn(),
  });
}
/*
 * FNXC:GitLabIssueComment 2026-07-15-11:20:
 * Two distinct task shapes, because this service and GitLabTrackingCommentService now own disjoint
 * cases (no more double comments on one item):
 *   `task`          — TRACKED: sourceIssue + gitlabTracking.item. The tracking service comments;
 *                     this service suppresses. buildGitLabTaskProvenance() emits this shape.
 *   `untrackedTask` — IMPORTED, NOT TRACKED: sourceIssue + source.sourceMetadata, no item (e.g. the
 *                     item was unlinked). resolveGitLabTarget() falls back to sourceMetadata, the
 *                     tracking service stays silent, and THIS service posts. The live
 *                     `gitlabCommentOnDone` path.
 */
const task: any = { id: "FN-1", title: "Fix", sourceIssue: { provider: "gitlab", repository: "g/p", issueNumber: 2, url: "https://gitlab.example.com/g/p/-/issues/2" }, gitlabTracking: { item: { kind: "project_issue", instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: "https://gitlab.example.com/g/p/-/issues/2", projectPath: "g/p", iid: 2, title: "Fix", state: "opened", linkedAt: "now" } } };
const untrackedTask: any = { id: "FN-1", title: "Fix", sourceIssue: { provider: "gitlab", repository: "g/p", issueNumber: 2, url: "https://gitlab.example.com/g/p/-/issues/2" }, source: { sourceType: "gitlab_import", sourceMetadata: { resourceType: "project_issue", iid: 2, projectPath: "g/p" } } };

describe("GitLabIssueCommentService", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("posts source completion comments to GitLab project issues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchImpl);
    const s = store();
    new GitLabIssueCommentService(s as any).start();
    s.emit("task:moved", { task: untrackedTask, from: "in-progress", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/2/notes");
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Posted GitLab issue completion comment", "g/p#2");
  });
  /*
   * FNXC:GitLabIssueComment 2026-07-15-10:05:
   * Parity coverage for the issue #1916 release lines. Version is injected so assertions do not
   * drift with each real release. Uses the untracked shape — a tracked item is suppressed here and
   * carries its release lines through GitLabTrackingCommentService instead.
   */
  it("appends release version lines for a Fusion self-repo source issue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchImpl);
    const s = store();
    new GitLabIssueCommentService(s as any, () => "0.60.0").start();
    const selfRepoTask = { ...untrackedTask, source: { ...untrackedTask.source, sourceMetadata: { ...untrackedTask.source.sourceMetadata, projectPath: "runfusion/fusion" } }, sourceIssue: { ...untrackedTask.sourceIssue, repository: "runfusion/fusion" } };
    s.emit("task:moved", { task: selfRepoTask, from: "in-progress", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body)).body as string;
    expect(body).toContain("Current version: v0.60.0");
    expect(body).toContain("Target release: v0.61.0");
  });

  it("leaves completion comments for every other project unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchImpl);
    const s = store();
    new GitLabIssueCommentService(s as any, () => "0.60.0").start();
    s.emit("task:moved", { task: untrackedTask, from: "in-progress", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as any).body)).body as string;
    expect(body).toBe("✅ Task FN-1 (Fix) has been completed and resolved.");
  });

  /*
   * FNXC:GitLabIssueComment 2026-07-15-11:20:
   * Regression coverage for the double-comment bug. buildGitLabTaskProvenance() always returns BOTH
   * sourceIssue and gitlabTracking.item, so before the fix EVERY imported GitLab task with
   * gitlabCommentOnDone on was commented twice — once here, once by GitLabTrackingCommentService.
   * Suppression must fire only when the tracking service will actually post.
   */
  it("suppresses its comment when a tracked item covers the same target", async () => {
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabIssueCommentService(s as any).start();
    s.emit("task:moved", { task, from: "in-progress", to: "done" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Skipped GitLab source comment", "g/p#2 is tracked; GitLab tracking comment covers it");
  });

  it("still posts for an imported issue with no tracked item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 })); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabIssueCommentService(s as any).start();
    s.emit("task:moved", { task: untrackedTask, from: "in-progress", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Posted GitLab issue completion comment", "g/p#2");
  });

  /*
   * FNXC:GitLabIssueComment 2026-07-15-11:20:
   * The tracking service no-ops when from === to, so suppressing there would drop the only comment.
   */
  it("still posts on a same-column re-emit, where the tracking service stays silent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 })); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabIssueCommentService(s as any).start();
    s.emit("task:moved", { task, from: "done", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  /*
   * FNXC:GitLabIssueComment 2026-07-15-11:20:
   * Documents a PRE-EXISTING gap, unchanged by the suppression fix: resolveGitLabTarget() early-returns
   * resolveGitLabTargetFromItem(item) whenever an item is present and never falls back to
   * sourceMetadata. So an item too incomplete to resolve (no projectId/projectPath) silences BOTH
   * services — the tracking one bails on the same unresolvable item, and this one skips as incomplete.
   * Suppression is not implicated (it is unreachable here); asserted so a future sourceMetadata
   * fallback is a deliberate change with a failing test, not an accident.
   */
  it("skips as incomplete when the tracked item cannot resolve (pre-existing: neither service comments)", async () => {
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabIssueCommentService(s as any).start();
    const unusableItem = { ...untrackedTask, gitlabTracking: { item: { kind: "project_issue", iid: 2, instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: "u", createdAt: "now" } } };
    s.emit("task:moved", { task: unusableItem, from: "in-progress", to: "done" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Skipped GitLab source comment", "Linked GitLab source metadata is incomplete");
  });

  it("skips non-GitLab and incomplete source metadata", async () => {
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    const s = store(); new GitLabIssueCommentService(s as any).start();
    s.emit("task:moved", { task: { ...task, sourceIssue: { provider: "github" } }, to: "done" });
    s.emit("task:moved", { task: { id: "FN-2", sourceIssue: { provider: "gitlab" }, gitlabTracking: { item: { kind: "group_issue", iid: 3 } } }, to: "done" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.logEntry).toHaveBeenCalledWith("FN-2", "Skipped GitLab source comment", "Linked GitLab source metadata is incomplete");
  });
});
