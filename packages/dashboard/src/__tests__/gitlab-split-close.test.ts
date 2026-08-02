import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    commentOnProjectIssue: vi.fn(),
    getProjectIssue: vi.fn(),
  },
  resolveClient: vi.fn(),
  resolveTarget: vi.fn(),
  log: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock("../gitlab-lifecycle.js", () => ({
  resolveGitLabClient: mocks.resolveClient,
  resolveGitLabTarget: mocks.resolveTarget,
  safeLogGitLabEntry: mocks.log,
}));
vi.mock("../gitlab-tracking-state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../gitlab-tracking-state.js")>(),
  updateGitLabTargetState: mocks.updateState,
}));

import {
  GitLabSplitCloseService,
  buildGitLabSplitCloseNote,
  postGitLabSplitNoteBeforeClose,
} from "../gitlab-split-close.js";

const target = { kind: "project_issue" as const, project: "group/project", iid: 24, label: "group/project#24" };
const task = { id: "FN-parent" } as any;
const split = { closureContext: { kind: "split-into-subtasks" as const, childTaskIds: ["FN-A", "FN-B"] } };

function store() {
  return Object.assign(new EventEmitter(), { logEntry: vi.fn(), getSettings: vi.fn(), getGlobalSettingsStore: vi.fn() });
}

async function flush(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }

describe("GitLab split-close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(target);
    mocks.resolveClient.mockResolvedValue({ ok: true, client: mocks.client });
    mocks.client.getProjectIssue.mockResolvedValue({ state: "opened" });
    mocks.client.commentOnProjectIssue.mockResolvedValue(undefined);
    mocks.updateState.mockResolvedValue(undefined);
  });

  it("posts the parent and every child before closing the split source issue", async () => {
    const s = store();
    new GitLabSplitCloseService(s as any).start();
    s.emit("task:deleted", task, split);
    await vi.waitFor(() => expect(mocks.updateState).toHaveBeenCalledTimes(1));

    expect(mocks.client.commentOnProjectIssue).toHaveBeenCalledTimes(1);
    expect(mocks.client.commentOnProjectIssue).toHaveBeenCalledWith("group/project", 24, expect.stringContaining("FN-parent"));
    const body = mocks.client.commentOnProjectIssue.mock.calls[0][2];
    expect(body).toContain("FN-A");
    expect(body).toContain("FN-B");
    expect(mocks.client.commentOnProjectIssue.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateState.mock.invocationCallOrder[0]);
    expect(mocks.updateState).toHaveBeenCalledWith(s, "FN-parent", target, "closed", "split-close");
  });

  it("normalizes duplicate child IDs and declines an empty handoff", () => {
    const note = buildGitLabSplitCloseNote("FN-parent", ["FN-A", "FN-A", "FN-B", ""]);
    expect(note).toContain("FN-A, FN-B");
    expect(note!.match(/FN-A/g)).toHaveLength(1);
    expect(buildGitLabSplitCloseNote("FN-parent", ["", ""])).toBeNull();
  });

  it.each([
    [undefined, "no-closure-context"],
    [{ closureContext: { kind: "other", childTaskIds: ["FN-A"] } }, "not-split"],
    [{ closureContext: { kind: "split-into-subtasks", childTaskIds: [] } }, "empty-child-ids"],
  ])("returns the typed no-op result for closure context %o", async (meta, reason) => {
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, meta as any)).resolves.toEqual({ status: "no-op", reason });
    expect(mocks.client.commentOnProjectIssue).not.toHaveBeenCalled();
  });

  it("returns typed no-ops for target, MR, closed issue, and unresolved auth", async () => {
    mocks.resolveTarget.mockReturnValueOnce(null);
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, split)).resolves.toEqual({ status: "no-op", reason: "no-target" });
    mocks.resolveTarget.mockReturnValueOnce({ ...target, kind: "merge_request" });
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, split)).resolves.toEqual({ status: "no-op", reason: "merge-request-target" });
    mocks.client.getProjectIssue.mockResolvedValueOnce({ state: "closed" });
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, split)).resolves.toEqual({ status: "no-op", reason: "already-closed" });
    mocks.resolveClient.mockResolvedValueOnce({ ok: false, message: "missing token" });
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, split)).resolves.toEqual({ status: "no-op", reason: "auth-unresolved" });
  });

  it("returns failed when its note cannot post and never closes for no-op or failed results", async () => {
    const error = new Error("note unavailable");
    mocks.client.commentOnProjectIssue.mockRejectedValue(error);
    await expect(postGitLabSplitNoteBeforeClose(store() as any, task, split)).resolves.toEqual({ status: "failed", reason: "comment-post-failed", error });

    const s = store();
    new GitLabSplitCloseService(s as any).start();
    s.emit("task:deleted", task, { closureContext: { kind: "split-into-subtasks", childTaskIds: [] } });
    s.emit("task:deleted", task, split);
    await flush();
    expect(mocks.updateState).not.toHaveBeenCalled();
  });

  it("keeps malformed tracking inert by using the default resolver call", async () => {
    mocks.resolveTarget.mockReturnValueOnce(null);
    const s = store();
    const malformedTask = { ...task, sourceIssue: { provider: "gitlab", repository: "g/p", issueNumber: 2 }, gitlabTracking: { item: { kind: "project_issue", iid: 2 } } };
    new GitLabSplitCloseService(s as any).start();
    s.emit("task:deleted", malformedTask, split);
    await flush();
    expect(mocks.resolveTarget).toHaveBeenCalledWith(malformedTask);
    expect(mocks.client.commentOnProjectIssue).not.toHaveBeenCalled();
    expect(mocks.updateState).not.toHaveBeenCalled();
  });

  it("uses the resolved tracking owner once, including when source metadata is also present", async () => {
    const s = store();
    new GitLabSplitCloseService(s as any).start();
    s.emit("task:deleted", { ...task, sourceIssue: { provider: "gitlab" }, gitlabTracking: { item: {} } }, split);
    await vi.waitFor(() => expect(mocks.updateState).toHaveBeenCalledTimes(1));
    expect(mocks.client.commentOnProjectIssue).toHaveBeenCalledTimes(1);
  });
});
