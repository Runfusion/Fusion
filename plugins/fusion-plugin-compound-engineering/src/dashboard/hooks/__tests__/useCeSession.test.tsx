import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PlanningQuestion } from "@fusion/core";
import { useCeSession, type CeSessionTransport } from "../useCeSession.js";
import type { CeSession } from "../../../session/session-store.js";

function mkSession(over: Partial<CeSession>): CeSession {
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
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

const Q: PlanningQuestion = { id: "q1", type: "text", question: "go?" };

function Harness({ transport }: { transport: CeSessionTransport }) {
  const s = useCeSession({ transport, pollIntervalMs: 5 });
  return (
    <div>
      <span data-testid="status">{s.session?.status ?? "none"}</span>
      <span data-testid="busy">{s.busy ? "busy" : "idle"}</span>
      <span data-testid="err">{s.error ?? ""}</span>
      <button onClick={() => void s.start("brainstorm")}>start</button>
      <button onClick={() => void s.answer("q1", "yes")}>answer</button>
      <button onClick={() => void s.resume()}>resume</button>
      <button onClick={() => s.reset()}>reset</button>
    </div>
  );
}

describe("useCeSession lifecycle", () => {
  it("start → awaiting_input → answer → completed", async () => {
    const transport: CeSessionTransport = {
      start: vi.fn(async () => mkSession({ status: "awaiting_input", currentQuestion: Q })),
      answer: vi.fn(async () => mkSession({ status: "completed", currentQuestion: null, artifactPath: "/a.md" })),
      resume: vi.fn(async () => mkSession({})),
      get: vi.fn(async () => mkSession({})),
    };
    render(<Harness transport={transport} />);

    await act(async () => {
      screen.getByText("start").click();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");

    await act(async () => {
      screen.getByText("answer").click();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("completed");
    expect(transport.answer).toHaveBeenCalledWith("s1", "q1", "yes");
  });

  it("polls while active and stops once settled", async () => {
    let calls = 0;
    const get = vi.fn(async () => {
      calls += 1;
      return calls >= 2 ? mkSession({ status: "awaiting_input", currentQuestion: Q }) : mkSession({ status: "active" });
    });
    const transport: CeSessionTransport = {
      start: vi.fn(async () => mkSession({ status: "active", currentQuestion: null })),
      answer: vi.fn(),
      resume: vi.fn(),
      get,
    };
    render(<Harness transport={transport} />);
    await act(async () => {
      screen.getByText("start").click();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("active");

    // Let the poll interval fire and converge to awaiting_input.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(get).toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");
  });

  it("surfaces a start error", async () => {
    const transport: CeSessionTransport = {
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
      answer: vi.fn(),
      resume: vi.fn(),
      get: vi.fn(),
    };
    render(<Harness transport={transport} />);
    await act(async () => {
      screen.getByText("start").click();
    });
    expect(screen.getByTestId("err")).toHaveTextContent("boom");
  });

  it("resume transitions an interrupted session", async () => {
    const transport: CeSessionTransport = {
      start: vi.fn(async () => mkSession({ status: "interrupted", currentQuestion: Q })),
      answer: vi.fn(),
      resume: vi.fn(async () => mkSession({ status: "awaiting_input", currentQuestion: Q })),
      get: vi.fn(async () => mkSession({ status: "interrupted", currentQuestion: Q })),
    };
    render(<Harness transport={transport} />);
    await act(async () => {
      screen.getByText("start").click();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("interrupted");
    await act(async () => {
      screen.getByText("resume").click();
    });
    expect(transport.resume).toHaveBeenCalledWith("s1");
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");
  });
});
