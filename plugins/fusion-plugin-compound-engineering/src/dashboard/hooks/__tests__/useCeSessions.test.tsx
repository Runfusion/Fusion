import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useCeSessions, type CeSessionsTransport, type CeSessionsSubscribe } from "../useCeSessions.js";
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

function Harness({
  transport,
  subscribe,
}: {
  transport: CeSessionsTransport;
  subscribe?: CeSessionsSubscribe;
}) {
  const s = useCeSessions({
    projectId: "p1",
    transport,
    pollIntervalMs: 5,
    ...(subscribe ? { subscribe } : {}),
  });
  return (
    <div>
      <span data-testid="count">{s.sessions.length}</span>
      <span data-testid="ids">{s.sessions.map((x) => x.id).join(",")}</span>
      <span data-testid="err">{s.error ?? ""}</span>
      <button onClick={() => void s.refresh()}>refresh</button>
      <button onClick={() => void s.remove("s1")}>remove</button>
    </div>
  );
}

describe("useCeSessions (multi-session list)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists all sessions on mount with the projectId", async () => {
    const list = vi.fn(async () => [mkSession({ id: "s1" }), mkSession({ id: "s2", stage: "plan" })]);
    const transport: CeSessionsTransport = { list, remove: vi.fn() };
    render(<Harness transport={transport} />);

    await act(async () => {});
    expect(list).toHaveBeenCalledWith("p1");
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByTestId("ids")).toHaveTextContent("s1,s2");
  });

  it("remove() deletes via the transport then refreshes the list", async () => {
    let removed = false;
    const transport: CeSessionsTransport = {
      list: vi.fn(async () => (removed ? [mkSession({ id: "s2" })] : [mkSession({ id: "s1" }), mkSession({ id: "s2" })])),
      remove: vi.fn(async () => {
        removed = true;
      }),
    };
    render(<Harness transport={transport} />);
    await act(async () => {});
    expect(screen.getByTestId("count")).toHaveTextContent("2");

    await act(async () => {
      screen.getByText("remove").click();
    });
    expect(transport.remove).toHaveBeenCalledWith("s1", "p1");
    expect(screen.getByTestId("ids")).toHaveTextContent("s2");
  });

  it("refreshes when a push event fires", async () => {
    let fire: (() => void) | undefined;
    const subscribe: CeSessionsSubscribe = (onAnyEvent) => {
      fire = onAnyEvent;
      return () => {
        fire = undefined;
      };
    };
    let n = 1;
    const transport: CeSessionsTransport = {
      list: vi.fn(async () => Array.from({ length: n }, (_, i) => mkSession({ id: `s${i + 1}` }))),
      remove: vi.fn(),
    };
    render(<Harness transport={transport} subscribe={subscribe} />);
    await act(async () => {});
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    n = 2;
    await act(async () => {
      fire?.();
      await Promise.resolve();
    });
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });

  it("polls while any session is mid-turn and stops when all settle", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const transport: CeSessionsTransport = {
      list: vi.fn(async () => {
        calls += 1;
        return [mkSession({ id: "s1", status: calls >= 3 ? "completed" : "active" })];
      }),
      remove: vi.fn(),
    };
    render(<Harness transport={transport} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const settledCalls = calls;
    expect(calls).toBeGreaterThanOrEqual(3);

    // All settled → polling stops (no further list calls as time advances).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(calls).toBe(settledCalls);
  });

  it("surfaces a list error without crashing", async () => {
    const transport: CeSessionsTransport = {
      list: vi.fn(async () => {
        throw new Error("kaput");
      }),
      remove: vi.fn(),
    };
    render(<Harness transport={transport} />);
    await act(async () => {});
    expect(screen.getByTestId("err")).toHaveTextContent("kaput");
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });
});
