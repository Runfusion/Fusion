import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoppedOutChats } from "../usePoppedOutChats";
import type { ChatSessionInfo } from "../useChat";

const session = (id: string, title = id): ChatSessionInfo => ({
  id, agentId: "agent-1", title, status: "active", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
});

describe("usePoppedOutChats", () => {
  it("deduplicates an exact project/session while retaining distinct windows", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a")));
    act(() => result.current.popOut("project-a", session("b")));
    act(() => result.current.popOut("project-a", session("a", "refreshed")));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.find((entry) => entry.session.id === "a")?.session.title).toBe("refreshed");

    act(() => result.current.close("project-a", "b"));
    expect(result.current.entries.map((entry) => entry.session.id)).toEqual(["a"]);
    act(() => result.current.closeAll());
    expect(result.current.entries).toEqual([]);
  });
});
