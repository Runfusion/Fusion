import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MailboxRelatedWorkLink } from "../MailboxRelatedWorkLink";

describe("MailboxRelatedWorkLink", () => {
  it("opens a task when task metadata and its handler are available", () => {
    const onOpenTask = vi.fn();
    render(<MailboxRelatedWorkLink metadata={{ taskId: "FN-8428" }} onOpenTask={onOpenTask} />);

    fireEvent.click(screen.getByTestId("mailbox-view-task"));
    expect(onOpenTask).toHaveBeenCalledWith("FN-8428");
  });

  it("opens a planning clarification session when no task target is available", () => {
    const onOpenPlanningSession = vi.fn();
    render(
      <MailboxRelatedWorkLink
        metadata={{ kind: "planning-clarification", sessionId: "planning-8428" }}
        onOpenPlanningSession={onOpenPlanningSession}
      />,
    );

    fireEvent.click(screen.getByTestId("mailbox-open-planning-session"));
    expect(onOpenPlanningSession).toHaveBeenCalledWith("planning-8428");
  });

  it("renders no control for ordinary messages or unavailable handlers", () => {
    const { rerender } = render(<MailboxRelatedWorkLink metadata={{ taskId: "FN-8428" }} />);
    expect(screen.queryByTestId("mailbox-view-task")).toBeNull();

    rerender(<MailboxRelatedWorkLink metadata={{ kind: "planning-clarification", sessionId: "planning-8428" }} />);
    expect(screen.queryByTestId("mailbox-open-planning-session")).toBeNull();

    rerender(<MailboxRelatedWorkLink metadata={{ kind: "ordinary" }} onOpenTask={vi.fn()} onOpenPlanningSession={vi.fn()} />);
    expect(screen.queryByTestId("mailbox-view-task")).toBeNull();
    expect(screen.queryByTestId("mailbox-open-planning-session")).toBeNull();
  });

  it("prefers the task destination when both valid targets exist", () => {
    const onOpenTask = vi.fn();
    const onOpenPlanningSession = vi.fn();
    render(
      <MailboxRelatedWorkLink
        metadata={{ kind: "planning-clarification", taskId: "FN-8428", sessionId: "planning-8428" }}
        onOpenTask={onOpenTask}
        onOpenPlanningSession={onOpenPlanningSession}
      />,
    );

    fireEvent.click(screen.getByTestId("mailbox-view-task"));
    expect(onOpenTask).toHaveBeenCalledWith("FN-8428");
    expect(onOpenPlanningSession).not.toHaveBeenCalled();
  });
});
