import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabTrackingStateService } from "../gitlab-tracking-state.js";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function store() { const emitter = new EventEmitter(); return Object.assign(emitter, { getSettings: vi.fn().mockResolvedValue({ gitlabAuthToken: "token", gitlabInstanceUrl: "https://gitlab.example.com" }), getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }), logEntry: vi.fn() }); }
function task(kind: "project_issue" | "group_issue" | "merge_request" = "project_issue"): any { return { id: "FN-1", gitlabTracking: { item: { kind, instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com", url: "url", projectPath: "g/p", iid: 2, title: "T", state: "opened", linkedAt: "now" } } }; }

describe("GitLabTrackingStateService", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("closes and reopens linked project issues", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ iid: 2, project_id: 7, title: "I", web_url: "url", state: "opened", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, project_id: 7, title: "I", web_url: "url", state: "closed", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, project_id: 7, title: "I", web_url: "url", state: "closed", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, project_id: 7, title: "I", web_url: "url", state: "opened", labels: [] }));
    vi.stubGlobal("fetch", fetchImpl); const s = store(); new GitLabTrackingStateService(s as any).start();
    s.emit("task:moved", { task: task(), from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    s.emit("task:moved", { task: task(), from: "done", to: "todo" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(fetchImpl.mock.calls[1][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/2?state_event=close");
    expect(fetchImpl.mock.calls[3][0]).toBe("https://gitlab.example.com/api/v4/projects/g%2Fp/issues/2?state_event=reopen");
  });
  it("skips merged merge requests and incomplete group issue metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ iid: 2, project_id: 7, title: "MR", web_url: "url", state: "merged", labels: [] }));
    vi.stubGlobal("fetch", fetchImpl); const s = store(); new GitLabTrackingStateService(s as any).start();
    s.emit("task:moved", { task: task("merge_request"), from: "todo", to: "done" });
    s.emit("task:moved", { task: { id: "FN-2", gitlabTracking: { item: { kind: "group_issue", iid: 3 } } }, from: "todo", to: "done" });
    await vi.waitFor(() => expect(s.logEntry).toHaveBeenCalledWith("FN-1", "Skipped closing GitLab merge request", "g/p!2 is merged and cannot be auto-closed"));
    expect(s.logEntry).toHaveBeenCalledWith("FN-2", "Failed to update GitLab tracking state", "Linked GitLab metadata is incomplete");
  });
  it("retries transient GitLab failures once", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "opened", labels: [] }))
      .mockResolvedValueOnce(jsonResponse({ message: "oops" }, 502))
      .mockResolvedValueOnce(jsonResponse({ iid: 2, title: "I", web_url: "url", state: "closed", labels: [] }));
    vi.stubGlobal("fetch", fetchImpl); const s = store(); new GitLabTrackingStateService(s as any).start();
    s.emit("task:moved", { task: task(), from: "todo", to: "done" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });
});
