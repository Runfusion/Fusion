import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiSessionSummary } from "../api";
import { SessionNotificationBanner } from "./SessionNotificationBanner";

function buildSession(overrides: Partial<AiSessionSummary>): AiSessionSummary {
  return {
    id: overrides.id ?? "session-1",
    type: overrides.type ?? "planning",
    status: overrides.status ?? "awaiting_input",
    title: overrides.title ?? "Draft implementation plan",
    projectId: overrides.projectId ?? "proj-1",
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe("SessionNotificationBanner", () => {
  it("renders nothing when no sessions need input", () => {
    const { container } = render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "a", status: "generating" }),
          buildSession({ id: "b", status: "complete" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders banner with correct awaiting_input count", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "a", title: "First", status: "awaiting_input" }),
          buildSession({ id: "b", title: "Second", status: "awaiting_input" }),
          buildSession({ id: "c", title: "Done", status: "complete" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("2 AI sessions need your input")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("does not render sessions that are generating or complete", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "planning", type: "planning", title: "Planning Session", status: "awaiting_input" }),
          buildSession({ id: "gen", title: "Generating", status: "generating" }),
          buildSession({ id: "complete", title: "Complete", status: "complete" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Planning Session")).toBeInTheDocument();
    expect(screen.queryByText("Generating")).not.toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });

  it("calls onResumeSession with the selected session", () => {
    const onResumeSession = vi.fn();
    const planningSession = buildSession({
      id: "planning-1",
      type: "planning",
      status: "awaiting_input",
      title: "Plan checkout flow",
    });

    render(
      <SessionNotificationBanner
        sessions={[planningSession]}
        onResumeSession={onResumeSession}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeSession).toHaveBeenCalledWith(planningSession);
  });

  it("calls onDismissSession with the session id", () => {
    const onDismissSession = vi.fn();

    render(
      <SessionNotificationBanner
        sessions={[buildSession({ id: "dismiss-1", title: "Dismiss me" })]}
        onResumeSession={vi.fn()}
        onDismissSession={onDismissSession}
        onDismissAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Dismiss me" }));
    expect(onDismissSession).toHaveBeenCalledWith("dismiss-1");
  });

  it("calls onDismissAll when clicking dismiss all", () => {
    const onDismissAll = vi.fn();

    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "a", title: "A" }),
          buildSession({ id: "b", title: "B" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={onDismissAll}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /dismiss all/i }));
    expect(onDismissAll).toHaveBeenCalledTimes(1);
  });

  it("shows type labels and icons for planning, subtask, and mission interview", () => {
    const { container } = render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "planning", type: "planning", title: "Plan" }),
          buildSession({ id: "subtask", type: "subtask", title: "Breakdown" }),
          buildSession({ id: "mission", type: "mission_interview", title: "Mission" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Subtask Breakdown")).toBeInTheDocument();
    expect(screen.getByText("Mission Interview")).toBeInTheDocument();

    expect(container.querySelector(".lucide-lightbulb")).toBeTruthy();
    expect(container.querySelector(".lucide-layers")).toBeTruthy();
    expect(container.querySelector(".lucide-target")).toBeTruthy();
  });

  it("removes dismissed sessions from the banner", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "first", title: "First Session" }),
          buildSession({ id: "second", title: "Second Session" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss First Session" }));

    expect(screen.queryByText("First Session")).not.toBeInTheDocument();
    expect(screen.getByText("Second Session")).toBeInTheDocument();
  });

  it("renders error sessions in the banner", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "error-session", type: "mission_interview", title: "Failed Mission", status: "error" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("Failed Mission")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows 'Retry' button for error sessions instead of 'Resume'", () => {
    const errorSession = buildSession({
      id: "error-1",
      type: "mission_interview",
      status: "error",
      title: "Error Session",
    });

    render(
      <SessionNotificationBanner
        sessions={[errorSession]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("calls onResumeSession when clicking Retry on error session", () => {
    const onResumeSession = vi.fn();
    const errorSession = buildSession({
      id: "error-retry",
      type: "mission_interview",
      status: "error",
      title: "Error to Retry",
    });

    render(
      <SessionNotificationBanner
        sessions={[errorSession]}
        onResumeSession={onResumeSession}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onResumeSession).toHaveBeenCalledWith(errorSession);
  });

  it("shows combined header text for both awaiting_input and error sessions", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "awaiting", status: "awaiting_input", title: "Awaiting Input" }),
          buildSession({ id: "error", status: "error", title: "Error Session" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("1 AI session needs your input, 1 failed")).toBeInTheDocument();
  });

  it("shows error count only when no awaiting_input sessions", () => {
    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "error1", status: "error", title: "Error 1" }),
          buildSession({ id: "error2", status: "error", title: "Error 2" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    expect(screen.getByText("2 AI sessions failed")).toBeInTheDocument();
  });

  it("dismisses error sessions from the banner", () => {
    const onDismissSession = vi.fn();

    render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "error-dismiss", status: "error", title: "Error to Dismiss" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={onDismissSession}
        onDismissAll={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Error to Dismiss" }));
    expect(onDismissSession).toHaveBeenCalledWith("error-dismiss");
  });

  it("preserves dismissed error sessions when session status changes", () => {
    const { rerender } = render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "session-1", status: "error", title: "Error Session" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    // Dismiss the error session
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Error Session" }));
    expect(screen.queryByText("Error Session")).not.toBeInTheDocument();

    // Simulate session status changing to complete (should NOT reappear)
    rerender(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "session-1", status: "complete", title: "Error Session" }),
        ]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    // Dismissed session should still be hidden even though status changed
    expect(screen.queryByText("Error Session")).not.toBeInTheDocument();
  });
});
