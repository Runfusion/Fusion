import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MessageMetadata } from "@fusion/core";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createTaskFromRecommendation, fetchTaskDetail } from "../../api";
import { MailboxTaskRecommendations } from "../MailboxTaskRecommendations";

vi.mock("../../api", () => ({ createTaskFromRecommendation: vi.fn(), fetchTaskDetail: vi.fn() }));

const metadata: MessageMetadata = { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: ["recommendation-1"] };
const detail = { id: "FN-9100", recommendations: [{ id: "recommendation-1", title: "Follow up", description: "Finish the optional work.", category: "feature" }] };

function expectMailboxCardWithoutBoardClass(): void {
  const card = screen.getByTestId("mailbox-task-recommendations").querySelector("article");
  expect(card).toHaveClass("mailbox-task-recommendations__item");
  expect(card).not.toHaveClass("card");
}

describe("MailboxTaskRecommendations", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders nothing for non-notices, missing parents, and empty recommendation ids", () => {
    for (const candidate of [{}, { kind: "task-recommendation-notice", recommendationIds: ["recommendation-1"] }, { kind: "task-recommendation-notice", taskId: "FN-9100", recommendationIds: [] }]) {
      const { container, unmount } = render(<MailboxTaskRecommendations metadata={candidate} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("keeps a failed parent lookup inert and explains the missing parent", async () => {
    vi.mocked(fetchTaskDetail).mockRejectedValue(new Error("not found"));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    await waitFor(() => expect(screen.getByTestId("mailbox-task-recommendations-unavailable")).toBeInTheDocument());
    expect(screen.getByText(/source task can no longer be loaded/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-task-recommendations")).not.toBeInTheDocument();
  });

  it("explains when a stale notice points at recommendation ids no longer on the task", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, recommendations: [] } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    await waitFor(() => expect(screen.getByTestId("mailbox-task-recommendations-unavailable")).toBeInTheDocument());
    expect(screen.getByText(/no longer contains the recommendation IDs/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
  });

  it("creates once and replaces the action with the linked task", async () => {
    const onOpenTask = vi.fn();
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockResolvedValue({ task: { id: "FN-9101" }, parent: detail } as never);
    render(<MailboxTaskRecommendations metadata={metadata} projectId="project-1" onOpenTask={onOpenTask} />);
    await screen.findByRole("button", { name: "Create task" });
    expectMailboxCardWithoutBoardClass();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "View task FN-9101" })).toBeInTheDocument());
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-9100", "recommendation-1", "project-1");
    fireEvent.click(screen.getByRole("button", { name: "View task FN-9101" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-9101");
  });

  it("shows existing links without a duplicate Create action", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue({ ...detail, recommendations: [{ ...detail.recommendations[0], createdTaskId: "FN-9101" }] } as never);
    render(<MailboxTaskRecommendations metadata={metadata} />);
    expect(await screen.findByRole("button", { name: "View task FN-9101" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expectMailboxCardWithoutBoardClass();
  });

  it("guards rapid duplicate clicks", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    let resolveCreate!: (value: never) => void;
    vi.mocked(createTaskFromRecommendation).mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve; }));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    await screen.findByRole("button", { name: "Create task" });
    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    expectMailboxCardWithoutBoardClass();
    fireEvent.click(button);
    expect(createTaskFromRecommendation).toHaveBeenCalledTimes(1);
    resolveCreate({ task: { id: "FN-9101" }, parent: detail } as never);
    await screen.findByRole("button", { name: "View task FN-9101" });
  });

  it("offers a retry after a rejected creation", async () => {
    vi.mocked(fetchTaskDetail).mockResolvedValue(detail as never);
    vi.mocked(createTaskFromRecommendation).mockRejectedValue(new Error("conflict"));
    render(<MailboxTaskRecommendations metadata={metadata} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("button", { name: "Retry creating task" })).toBeInTheDocument();
    expect(screen.getByText("Could not create task. Try again.")).toBeInTheDocument();
    expectMailboxCardWithoutBoardClass();
  });
});
