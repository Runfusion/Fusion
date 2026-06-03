import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PlanningQuestion } from "@fusion/core";
import { useCeSession, type CeSessionTransport, type CeSessionSubscribe } from "../useCeSession.js";
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
      <button onClick={() => void s.start("brainstorm", { projectId: "p1" })}>start</button>
      <button onClick={() => void s.open("s2", { projectId: "p2" })}>open</button>
      <button onClick={() => void s.answer("q1", "yes")}>answer</button>
      <button onClick={() => void s.resume()}>resume</button>
      <button onClick={() => s.reset()}>reset</button>
    </div>
  );
}

describe("useCeSession lifecycle", () => {
  afterEach(() => {
    // Ensure faked timers never leak into the next test.
    vi.useRealTimers();
  });

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
    // projectId from start() must thread through to answer() (FN: per-request
    // store resolution selects the session's owning store/live handle).
    expect(transport.answer).toHaveBeenCalledWith("s1", "q1", "yes", "p1");
  });

  it("threads the start projectId through resume and poll", async () => {
    vi.useFakeTimers();
    const get = vi.fn(async () => mkSession({ status: "active" }));
    const transport: CeSessionTransport = {
      start: vi.fn(async () => mkSession({ status: "interrupted", currentQuestion: Q })),
      answer: vi.fn(),
      resume: vi.fn(async () => mkSession({ status: "active" })),
      get,
    };
    render(<Harness transport={transport} />);
    await act(async () => {
      screen.getByText("start").click();
    });
    await act(async () => {
      screen.getByText("resume").click();
    });
    expect(transport.resume).toHaveBeenCalledWith("s1", "p1");
    // The poll (active status) must also carry the projectId. Harness uses a 5ms
    // interval; advance fake time deterministically past one tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(get).toHaveBeenCalledWith("s1", "p1");
  });

  it("polls while active and stops once settled", async () => {
    vi.useFakeTimers();
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

    // Advance fake time so the poll interval fires and converges to awaiting_input.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(get).toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");
  });

  it("open() adopts an existing session and threads ITS projectId to later calls", async () => {
    const transport: CeSessionTransport = {
      start: vi.fn(),
      answer: vi.fn(async () => mkSession({ id: "s2", status: "completed" })),
      resume: vi.fn(),
      get: vi.fn(async () => mkSession({ id: "s2", status: "awaiting_input", currentQuestion: Q })),
    };
    render(<Harness transport={transport} />);

    await act(async () => {
      screen.getByText("open").click();
    });
    expect(transport.get).toHaveBeenCalledWith("s2", "p2");
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");

    // Subsequent answer goes to the opened session with the opened projectId.
    await act(async () => {
      screen.getByText("answer").click();
    });
    expect(transport.answer).toHaveBeenCalledWith("s2", "q1", "yes", "p2");
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
    expect(transport.resume).toHaveBeenCalledWith("s1", "p1");
    expect(screen.getByTestId("status")).toHaveTextContent("awaiting_input");
  });

  it("refetches when a session event is pushed over the subscribe seam", async () => {
    let fire: (() => void) | undefined;
    const subscribe: CeSessionSubscribe = (_sessionId, _projectId, onSessionEvent) => {
      fire = onSessionEvent;
      return () => {
        fire = undefined;
      };
    };
    const get = vi.fn(async () => mkSession({ status: "completed", currentQuestion: null, artifactPath: "/a.md" }));
    const transport: CeSessionTransport = {
      // start returns an active (mid-turn) session; without a push or poll it stays active.
      start: vi.fn(async () => mkSession({ status: "active", currentQuestion: null })),
      answer: vi.fn(),
      resume: vi.fn(),
      get,
    };

    function PushHarness() {
      const s = useCeSession({ transport, subscribe, pollIntervalMs: 100000 });
      return (
        <div>
          <span data-testid="status">{s.session?.status ?? "none"}</span>
          <button onClick={() => void s.start("brainstorm", { projectId: "p1" })}>start</button>
        </div>
      );
    }

    render(<PushHarness />);
    await act(async () => {
      screen.getByText("start").click();
    });
    expect(screen.getByTestId("status")).toHaveTextContent("active");

    // A pushed event triggers an immediate refetch (no poll interval elapsed).
    await act(async () => {
      fire?.();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledWith("s1", "p1");
    expect(screen.getByTestId("status")).toHaveTextContent("completed");
  });
});
