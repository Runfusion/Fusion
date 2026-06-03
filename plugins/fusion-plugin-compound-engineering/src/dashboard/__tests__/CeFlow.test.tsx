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

describe("CeFlow — steering (guidance channel)", () => {
  const q: PlanningQuestion = {
    id: "q-steer",
    type: "single_select",
    question: "Pick a direction",
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
  };

  it("attaches typed guidance to the chosen answer as {value, comment}", () => {
    const onAnswer = vi.fn();
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByTestId("ce-flow-guidance-input"), {
      target: { value: "focus on mobile" },
    });
    fireEvent.click(screen.getByText("Beta"));
    expect(onAnswer).toHaveBeenCalledWith("q-steer", { value: "b", comment: "focus on mobile" });
  });

  it("sends guidance WITHOUT answering as {feedback}", () => {
    const onAnswer = vi.fn();
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    const send = screen.getByTestId("ce-flow-guidance-send");
    expect(send).toBeDisabled(); // empty guidance can't be sent
    fireEvent.change(screen.getByTestId("ce-flow-guidance-input"), {
      target: { value: "skip auth for now" },
    });
    fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledWith("q-steer", { feedback: "skip auth for now" });
  });

  it("plain answers stay unwrapped when no guidance is typed", () => {
    const onAnswer = vi.fn();
    render(<CeFlow session={makeSession({ currentQuestion: q })} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByText("Alpha"));
    expect(onAnswer).toHaveBeenCalledWith("q-steer", "a");
  });

  it("free-text questions get no extra guidance box (their answer field already takes free text)", () => {
    const textQ: PlanningQuestion = { id: "q-text", type: "text", question: "Goal?" };
    render(<CeFlow session={makeSession({ currentQuestion: textQ })} onAnswer={vi.fn()} />);
    expect(screen.queryByTestId("ce-flow-guidance")).not.toBeInTheDocument();
  });
});

describe("CeFlow — Q&A transcript rendering", () => {
  const pastQ: PlanningQuestion = {
    id: "q-past",
    type: "single_select",
    question: "Which path?",
    options: [
      { id: "x", label: "The X path" },
      { id: "y", label: "The Y path" },
    ],
  };

  function historyWith(answer: unknown) {
    return [
      { role: "user" as const, text: "kick off", at: "t0" },
      { role: "agent" as const, text: JSON.stringify({ question: pastQ }), at: "t1" },
      { role: "user" as const, text: JSON.stringify({ answer, questionId: "q-past" }), at: "t2" },
    ];
  }

  it("renders past questions and answers as bubbles, mapping option ids to labels", () => {
    render(
      <CeFlow
        session={makeSession({ status: "active", conversationHistory: historyWith("y") })}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId("ce-flow-past-question")).toHaveTextContent("Which path?");
    // The answer shows the LABEL, not the raw option id.
    expect(screen.getByTestId("ce-flow-past-answer")).toHaveTextContent("The Y path");
    // The opening message renders as a plain user bubble.
    expect(screen.getByText("kick off")).toBeInTheDocument();
  });

  it("renders {value, comment} answers with the steering comment attached", () => {
    render(
      <CeFlow
        session={makeSession({
          status: "active",
          conversationHistory: historyWith({ value: "x", comment: "but keep it small" }),
        })}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId("ce-flow-past-answer")).toHaveTextContent("The X path");
    expect(screen.getByTestId("ce-flow-answer-comment")).toHaveTextContent("but keep it small");
  });

  it("renders {feedback} turns as steering, not answers", () => {
    render(
      <CeFlow
        session={makeSession({
          status: "active",
          conversationHistory: historyWith({ feedback: "go another way" }),
        })}
        onAnswer={vi.fn()}
      />,
    );
    const turn = screen.getByTestId("ce-flow-past-answer");
    expect(turn).toHaveTextContent("You steered");
    expect(turn).toHaveTextContent("go another way");
  });

  it("renders persisted working traces as a collapsible activity block", () => {
    const history = [
      {
        role: "agent" as const,
        text: JSON.stringify({
          activity: {
            turns: [
              { kind: "thinking", text: "Scanning the repo…", at: "t" },
              { kind: "tool", text: "Read", at: "t", done: true },
            ],
          },
        }),
        at: "t1",
      },
    ];
    render(<CeFlow session={makeSession({ status: "active", conversationHistory: history })} onAnswer={vi.fn()} />);
    const details = screen.getByTestId("ce-flow-activity");
    expect(details).toHaveTextContent("Agent work (2 steps)");
    expect(screen.getByText("Scanning the repo…")).toBeInTheDocument();
    expect(screen.getByTestId("ce-activity-tool")).toHaveTextContent("Read");
  });
});

describe("CeFlow — lifecycle surfaces", () => {
  it("shows the working pane while a turn runs", () => {
    render(<CeFlow session={makeSession({ status: "active", currentQuestion: null })} busy onAnswer={vi.fn()} />);
    expect(screen.getByTestId("ce-flow-thinking")).toBeInTheDocument();
  });

  it("streams live working output (thinking + tools) while the agent works", () => {
    const session = makeSession({
      status: "active",
      currentQuestion: null,
      liveActivity: [
        { kind: "thinking", text: "Considering options…", at: "t" },
        { kind: "tool", text: "Grep", at: "t", done: false },
      ],
    });
    render(<CeFlow session={session} onAnswer={vi.fn()} />);
    const pane = screen.getByTestId("ce-flow-live-activity");
    expect(pane).toHaveTextContent("Considering options…");
    expect(screen.getByTestId("ce-activity-tool")).toHaveTextContent("Grep");
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
