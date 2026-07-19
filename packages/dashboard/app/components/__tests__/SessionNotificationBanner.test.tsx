import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AiSessionSummary } from "../../api";
import { SessionNotificationBanner, dismissedIds } from "../SessionNotificationBanner";
import { shouldShowSessionInBanner } from "../../utils/appLifecycle";

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
  beforeEach(() => {
    dismissedIds.clear();
  });

  it("renders nothing when no sessions need input or are in progress", () => {
    const { container } = render(
      <SessionNotificationBanner
        sessions={[
          buildSession({ id: "a", status: "complete" }),
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

  it("renders an in-progress entry and resumes non-planning work", () => {
    const onResumeSession = vi.fn();
    const generating = buildSession({ id: "gen", type: "subtask", title: "Generating", status: "generating" });
    render(<SessionNotificationBanner sessions={[generating]} onResumeSession={onResumeSession} onDismissSession={vi.fn()} onDismissAll={vi.fn()} />);
    expect(screen.getByText("1 AI session in progress")).toBeInTheDocument();
    expect(screen.getByText("Generating")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeSession).toHaveBeenCalledWith(generating);
  });

  it("renders cli progress observationally without a dead Resume button", () => {
    render(<SessionNotificationBanner sessions={[buildSession({ id: "cli-progress", type: "cli-agent", title: "CLI progress", status: "generating" })]} onResumeSession={vi.fn()} onDismissSession={vi.fn()} onDismissAll={vi.fn()} />);
    expect(screen.getByText("CLI progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
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

  it("keeps planning sessions out through the production banner predicate", () => {
    const planningSessions = ["generating", "awaiting_input", "error"].map((status) =>
      buildSession({ id: `planning-${status}`, type: "planning", status: status as AiSessionSummary["status"], title: `Planning ${status}` }),
    );
    const filtered = planningSessions.filter(shouldShowSessionInBanner);
    const { container } = render(<SessionNotificationBanner sessions={filtered} onResumeSession={vi.fn()} onDismissSession={vi.fn()} onDismissAll={vi.fn()} />);
    expect(filtered).toEqual([]);
    expect(container.firstChild).toBeNull();
  });

  it("keeps a mixed non-planning entry visible through the production filter", () => {
    const sessions = [
      buildSession({ id: "planning", type: "planning", status: "error", title: "Excluded planning" }),
      buildSession({ id: "cli", type: "cli-agent", status: "waiting_on_input", title: "Visible CLI session" }),
    ].filter(shouldShowSessionInBanner);
    render(<SessionNotificationBanner sessions={sessions} onResumeSession={vi.fn()} onDismissSession={vi.fn()} onDismissAll={vi.fn()} />);
    expect(screen.queryByText("Excluded planning")).not.toBeInTheDocument();
    expect(screen.getByText("Visible CLI session")).toBeInTheDocument();
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

// ── CLI agent extensions (CLI Agent Executor, U11) ──────────────────────────
function buildCliSession(overrides: Partial<AiSessionSummary>): AiSessionSummary {
  return {
    id: overrides.id ?? "cli-1",
    type: "cli-agent",
    status: overrides.status ?? "waiting_on_input",
    title: overrides.title ?? "Implement FN-1",
    projectId: overrides.projectId ?? "proj-1",
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    cliVariant: overrides.cliVariant,
    cliSessionId: Object.prototype.hasOwnProperty.call(overrides, "cliSessionId") ? overrides.cliSessionId : "cli-1",
  };
}

describe("SessionNotificationBanner — cli-agent (U11)", () => {
  beforeEach(() => dismissedIds.clear());

  it("renders the cli-agent type without crashing (union regression)", () => {
    expect(() =>
      render(
        <SessionNotificationBanner
          sessions={[buildCliSession({ status: "waiting_on_input" })]}
          onResumeSession={vi.fn()}
          onDismissSession={vi.fn()}
          onDismissAll={vi.fn()}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("Implement FN-1")).toBeInTheDocument();
  });

  it("waiting_on_input transitions to observable generating progress (F2)", () => {
    const { rerender, container } = render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "waiting_on_input" })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );
    expect(container.querySelector(".session-notification-banner")).toBeTruthy();

    rerender(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "generating" as AiSessionSummary["status"] })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );
    expect(container.querySelector(".session-notification-banner")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("userExited needs-attention renders pinned copy + Advance/Retry/Cancel task", () => {
    const onCliAction = vi.fn();
    render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "needs_attention", cliVariant: "userExited" })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
        onCliAction={onCliAction}
      />,
    );
    expect(screen.getByText("Agent exited before completing")).toBeInTheDocument();
    // All three pinned actions render before any action removes the item.
    expect(screen.getByText("Advance")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Cancel task")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Advance"));
    expect(onCliAction).toHaveBeenCalledWith(expect.objectContaining({ id: "cli-1" }), "advance");
  });

  it("authFailed renders Re-authenticate / Retry", () => {
    render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "needs_attention", cliVariant: "authFailed" })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
        onCliAction={vi.fn()}
      />,
    );
    expect(screen.getByText("CLI authentication failed")).toBeInTheDocument();
    expect(screen.getByText("Re-authenticate")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it.each(["desktop", "mobile"] as const)(
    "resume-exhausted renders an enabled Relaunch fresh action at the %s breakpoint",
    (breakpoint) => {
      const onCliAction = vi.fn();
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: breakpoint === "mobile" ? 390 : 1280,
      });
      window.dispatchEvent(new Event("resize"));

      render(
        <SessionNotificationBanner
          sessions={[buildCliSession({ status: "needs_attention", cliVariant: "resume-exhausted" })]}
          onResumeSession={vi.fn()}
          onDismissSession={vi.fn()}
          onDismissAll={vi.fn()}
          onCliAction={onCliAction}
        />,
      );
      expect(screen.getByText("Couldn't resume the session")).toBeInTheDocument();
      const relaunchButton = screen.getByRole("button", { name: "Relaunch fresh" });
      expect(relaunchButton).not.toBeDisabled();
      expect(relaunchButton).not.toHaveAttribute("aria-disabled");
      expect(relaunchButton).not.toHaveAttribute("data-cli-action-disabled");
      fireEvent.click(relaunchButton);
      expect(onCliAction).toHaveBeenCalledWith(expect.objectContaining({ id: "cli-1" }), "relaunch");
      expect(screen.getByText("Cancel task")).toBeInTheDocument();
    },
  );

  it("renders relaunch disabled when the host reports a missing CLI session id", () => {
    const onCliAction = vi.fn();
    render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "needs_attention", cliVariant: "resume-exhausted", cliSessionId: undefined })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
        onCliAction={onCliAction}
        getCliActionDisabledReason={(session, action) =>
          action === "relaunch" && !session.cliSessionId ? "CLI session id is missing." : null
        }
      />,
    );

    const relaunchButton = screen.getByRole("button", { name: /Relaunch fresh unavailable: CLI session id is missing/i });
    expect(relaunchButton).toBeDisabled();
    fireEvent.click(relaunchButton);
    expect(onCliAction).not.toHaveBeenCalled();
  });

  it.each([
    ["userExited", ["advance", "retry", "cancel"]],
    ["authFailed", ["reauthenticate", "retry"]],
    ["resume-exhausted", ["relaunch", "cancel"]],
  ] as const)("makes every %s action observable or disabled", (cliVariant, actions) => {
    for (const action of actions) {
      dismissedIds.clear();
      const onCliAction = vi.fn();
      const onDismissSession = vi.fn();
      const { unmount } = render(
        <SessionNotificationBanner
          sessions={[buildCliSession({ status: "needs_attention", cliVariant })]}
          onResumeSession={vi.fn()}
          onDismissSession={onDismissSession}
          onDismissAll={vi.fn()}
          onCliAction={onCliAction}
          getCliActionDisabledReason={() => null}
        />,
      );

      const button = document.querySelector<HTMLButtonElement>(`[data-cli-action="${action}"]`);
      expect(button).toBeTruthy();
      if (button?.disabled) {
        expect(button).toHaveAccessibleName(/unavailable:/i);
        expect(onCliAction).not.toHaveBeenCalled();
      } else {
        fireEvent.click(button!);
        expect(onCliAction).toHaveBeenCalledWith(expect.objectContaining({ id: "cli-1" }), action);
        if (action === "advance" || action === "cancel") {
          expect(onDismissSession).toHaveBeenCalledWith("cli-1");
        } else {
          expect(onDismissSession).not.toHaveBeenCalled();
        }
      }
      unmount();
    }
  });

  it("disables CLI actions when the host provides no action handler", () => {
    render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "needs_attention", cliVariant: "authFailed" })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    for (const button of screen.getAllByRole("button").filter((node) => node.hasAttribute("data-cli-action"))) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleName(/unavailable:/i);
    }
  });

  it("disables actions that require a missing cliSessionId without leaving an empty click target", () => {
    const onCliAction = vi.fn();
    render(
      <SessionNotificationBanner
        sessions={[buildCliSession({ status: "needs_attention", cliVariant: "userExited", cliSessionId: undefined })]}
        onResumeSession={vi.fn()}
        onDismissSession={vi.fn()}
        onDismissAll={vi.fn()}
        onCliAction={onCliAction}
        getCliActionDisabledReason={(session, action) =>
          action === "advance" && !session.cliSessionId ? "CLI session id is missing." : null
        }
      />,
    );

    const advance = screen.getByRole("button", { name: /advance unavailable: cli session id is missing/i });
    expect(advance).toBeDisabled();
    expect(advance).toHaveAttribute("data-cli-action-disabled", "true");
    expect(advance).toHaveTextContent("Advance");
    fireEvent.click(advance);
    expect(onCliAction).not.toHaveBeenCalled();
  });
});
