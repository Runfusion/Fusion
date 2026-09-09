import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { createTaskFromRecommendation } = vi.hoisted(() => ({ createTaskFromRecommendation: vi.fn(async () => ({ task: { id: "FN-326" } })) }));
vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(async () => ({ recommendations: [{ id: "rec-1", title: "Add follow-up", description: "Ship the follow-up work.", category: "ux" }] })),
  createTaskFromRecommendation,
  artifactMediaUrlWithToken: vi.fn(),
}));
vi.mock("../ArtifactImageViewer", () => ({ ArtifactImage: () => null, ArtifactImageViewer: () => null }));

import { MailboxTaskCompletion } from "../MailboxTaskCompletion";

describe("MailboxTaskCompletion", () => {
  it("resolves compact completion recommendation ids through the legacy guarded action", async () => {
    render(<MailboxTaskCompletion metadata={{ kind: "task-completion-notice", taskId: "FN-325", recommendationIds: ["rec-1"] }} projectId="project-1" />);

    expect(await screen.findByRole("region", { name: "Task completion" })).toHaveTextContent("Add follow-up");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(createTaskFromRecommendation).toHaveBeenCalledWith("FN-325", "rec-1", "project-1");
  });

  it("does not replace archived legacy recommendation notices", () => {
    const { container } = render(<MailboxTaskCompletion metadata={{ kind: "task-recommendation-notice", taskId: "FN-1" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
