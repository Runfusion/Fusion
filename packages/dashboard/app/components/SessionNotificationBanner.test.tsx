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
});
