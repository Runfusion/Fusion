import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeTask, mockConfirm, noop, noopDelete, noopMerge, noopMove, noopOpenDetail, setupTaskDetailModalHooks } from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

setupTaskDetailModalHooks();

const projectIssue = {
  kind: "project_issue" as const,
  url: "https://gitlab.com/acme/app/-/issues/42",
  instanceUrl: "https://gitlab.com",
  host: "gitlab.com",
  iid: 42,
  projectPath: "acme/app",
  title: "Project issue",
  state: "opened",
  createdAt: "2026-07-02T00:00:00.000Z",
  lastSyncedAt: "2026-07-02T00:01:00.000Z",
};

function renderModal(task = makeTask({ column: "todo", gitlabTracking: { item: projectIssue } }), onTaskUpdated = vi.fn()) {
  return render(
    <TaskDetailModal
      initialTab="details"
      task={task}
      onClose={noop}
      onDeleteTask={noopDelete}
      onMergeTask={noopMerge}
      onOpenDetail={noopOpenDetail}
      onTaskUpdated={onTaskUpdated}
      addToast={noop}
    />,
  );
}

describe("TaskDetailModal GitLab tracking", () => {
  it("renders linked project issue metadata with provider-correct labels and actions", async () => {
    const user = userEvent.setup();
    renderModal();

    expect(screen.getByText("GitLab tracking")).toBeInTheDocument();
    expect(screen.getByText("Linked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Project issue #42" })).toHaveAttribute("href", projectIssue.url);

    await user.click(screen.getByRole("button", { name: "Expand GitLab tracking details" }));
    expect(screen.getByText("Kind")).toBeInTheDocument();
    expect(screen.getByText("gitlab.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open linked GitLab item" })).toHaveAttribute("href", projectIssue.url);
    expect(screen.getByRole("button", { name: "Unlink GitLab item" })).toBeInTheDocument();
    expect(screen.queryByText("GitHub tracking")).not.toBeInTheDocument();
  });

  it("renders group issues, merge requests, stale state, and GitHub coexistence", async () => {
    const user = userEvent.setup();
    const staleGroupIssue = {
      kind: "group_issue" as const,
      url: "https://git.example.test/groups/platform/-/issues/9",
      instanceUrl: "https://git.example.test",
      host: "git.example.test",
      iid: 9,
      groupPath: "platform",
      title: "Group issue",
      state: "opened",
      createdAt: "2026-07-02T00:00:00.000Z",
      staleAt: "2026-07-02T01:00:00.000Z",
      staleReason: "GitLab sync failed",
    };
    const task = makeTask({
      column: "todo",
      gitlabTracking: { item: staleGroupIssue },
      githubTracking: { enabled: true, repoOverride: "runfusion/fusion" },
    });
    const { rerender } = renderModal(task);

    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Group issue #9" })).toBeInTheDocument();
    expect(screen.getByText("GitHub tracking")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand GitLab tracking details" }));
    expect(screen.getByText("GitLab sync failed")).toBeInTheDocument();

    rerender(
      <TaskDetailModal
        initialTab="details"
        /*
        FNXC:TaskDetailStateStability 2026-08-15-22:25:
        FN-8796 (1320265455) made mergeTaskSnapshot clock-arbitrated: an equal-clock sparse
        prop no longer replaces populated detail fields, so this rerender must carry a newer
        `updatedAt` to model a real server mutation (see makeUpdatedTask's contract note).
        */
        task={makeTask({ column: "todo", updatedAt: "2026-01-01T00:00:01Z", gitlabTracking: { item: { ...projectIssue, kind: "merge_request", iid: 5, url: "https://gitlab.com/acme/app/-/merge_requests/5", title: "MR" } } })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );
    expect(screen.getByRole("link", { name: "Merge request !5" })).toBeInTheDocument();
  });

  it("unlinks after confirmation and does not render empty GitLab shells", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    const { updateTask } = await import("../../api");
    vi.mocked(updateTask).mockResolvedValueOnce(makeTask({ column: "todo", gitlabTracking: { unlinkedAt: "2026-07-02T00:00:00.000Z" } }) as any);
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderModal(undefined, onTaskUpdated);

    await user.click(screen.getByRole("button", { name: "Expand GitLab tracking details" }));
    await user.click(screen.getByRole("button", { name: "Unlink GitLab item" }));
    expect(updateTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Unlink GitLab item" }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith("FN-099", { gitlabTracking: { item: null } }, undefined));
    expect(onTaskUpdated).toHaveBeenCalled();
  });

  it("omits GitLab tracking section when metadata is empty", () => {
    renderModal(makeTask({ column: "todo", gitlabTracking: undefined }));
    expect(screen.queryByTestId("detail-gitlab-tracking-section")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/GitLab/i)).not.toBeInTheDocument();
  });
});
