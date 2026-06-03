import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlanningQuestion } from "@fusion/core";
import { CeFlow } from "../CeFlow.js";
import type { CeSession } from "../../session/session-store.js";

function makeSession(over: Partial<CeSession> & { currentQuestion?: PlanningQuestion | null }): CeSession {
  return {
    id: "s1",
    stage: "brainstorm",
    status: "awaiting_input",
    currentQuestion: null,
    conversationHistory: [],
    projectId: null,
    artifactPath: null,
    error: null,
    turnIntervalMs: 1000,
    lastActivityAt: Date.now(),
    createdAt: "2026-06-02T00:00:00Z",
    updatedAt: "2026-06-02T00:00:00Z",
    ...over,
  };
}

describe("CeFlow — rich question rendering + submit", () => {
  it("renders + submits a text question", () => {
    const onAnswer = vi.fn();
    const q: PlanningQuestion = { id: "q-text", type: "text", question: "What's the goal?" };
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);

    const input = screen.getByTestId("ce-flow-text-input");
    fireEvent.change(input, { target: { value: "ship faster" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledWith("q-text", "ship faster");
  });

  it("renders + submits a single_select question", () => {
    const onAnswer = vi.fn();
    const q: PlanningQuestion = {
      id: "q-single",
      type: "single_select",
      question: "Pick a direction",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    };
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("Beta"));
    expect(onAnswer).toHaveBeenCalledWith("q-single", "b");
  });

  it("renders + submits a multi_select question", () => {
    const onAnswer = vi.fn();
    const q: PlanningQuestion = {
      id: "q-multi",
      type: "multi_select",
      question: "Which goals?",
      options: [
        { id: "g1", label: "Speed" },
        { id: "g2", label: "Quality" },
        { id: "g3", label: "Cost" },
      ],
    };
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    const boxes = screen.getByTestId("ce-flow-multi").querySelectorAll("input[type=checkbox]");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByTestId("ce-flow-multi-submit"));
    expect(onAnswer).toHaveBeenCalledWith("q-multi", ["g1", "g3"]);
  });

  it("renders + submits a confirm question (both branches)", () => {
    const onAnswer = vi.fn();
    const q: PlanningQuestion = { id: "q-c", type: "confirm", question: "Write the doc now?" };
    const { rerender } = render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId("ce-flow-confirm-yes"));
    expect(onAnswer).toHaveBeenLastCalledWith("q-c", true);
    rerender(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId("ce-flow-confirm-no"));
    expect(onAnswer).toHaveBeenLastCalledWith("q-c", false);
  });
});

describe("CeFlow — degraded fallback (AE1)", () => {
  it("falls back to a visibly-degraded chat view for an unrenderable interaction, and the stage still completes", () => {
    const onAnswer = vi.fn();
    // A type CeFlow cannot express richly — degrades to chat.
    const rogue = {
      id: "q-rogue",
      type: "rank_order",
      question: "Rank these by priority",
      options: [{ id: "a", label: "A" }],
    } as unknown as PlanningQuestion;

    const { rerender } = render(<CeFlow session={makeSession({ currentQuestion: rogue })} onAnswer={onAnswer} />);

    // Visibly marked as degraded.
    const banner = screen.getByTestId("ce-flow-degraded-banner");
    expect(banner).toBeInTheDocument();
    expect(screen.queryByTestId("ce-flow-question")).not.toBeInTheDocument();

    // Stage is still completable: free-text answer submits through the same route.
    fireEvent.change(screen.getByTestId("ce-flow-degraded-input"), { target: { value: "A then B" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onAnswer).toHaveBeenCalledWith("q-rogue", "A then B");

    // After the answer the orchestrator reaches `complete` → CeFlow shows done.
    rerender(
      <CeFlow
        session={makeSession({ status: "completed", currentQuestion: null, artifactPath: "/repo/docs/brainstorms/x.md" })}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("ce-flow-complete")).toBeInTheDocument();
    expect(screen.getByTestId("ce-flow-artifact-path")).toHaveTextContent("/repo/docs/brainstorms/x.md");
  });

  it("degrades a select question that arrives with no options", () => {
    const onAnswer = vi.fn();
    const q: PlanningQuestion = { id: "q-empty", type: "single_select", question: "Pick", options: [] };
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    expect(screen.getByTestId("ce-flow-degraded")).toBeInTheDocument();
  });
});

describe("CeFlow — lifecycle surfaces", () => {
  it("shows thinking while a turn runs", () => {
    render(<CeFlow session={makeSession({ status: "active", currentQuestion: null })} busy onAnswer={vi.fn()} />);
    expect(screen.getByTestId("ce-flow-thinking")).toBeInTheDocument();
  });

  it("offers resume on an interrupted session", () => {
    const onResume = vi.fn();
    render(
      <CeFlow
        session={makeSession({ status: "interrupted", currentQuestion: null, error: "stalled" })}
        onAnswer={vi.fn()}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByTestId("ce-flow-resume"));
    expect(onResume).toHaveBeenCalled();
  });
});
