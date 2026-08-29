import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { TaskView } from "../useViewState";

const { handlers } = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: MessageEvent) => void>,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { events: Record<string, (e: MessageEvent) => void> }) => {
    Object.assign(handlers, opts.events);
    return () => {};
  }),
}));

import { useChatUnreadBadge } from "../useChatUnreadBadge";
import { message } from "./sseTestHelpers";

describe("useChatUnreadBadge", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks unread on an assistant message while not viewing chat", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });

  it("ignores planner assistant messages hidden from the global Chat feed", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(
        message({ role: "assistant", sessionId: "sess-planner", agentId: "task-planner:FN-7392" }),
      );
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("ignores planner assistant messages when session metadata carries the synthetic agent id", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(
        message({ role: "assistant", sessionId: "sess-planner", session: { agentId: "task-planner:FN-7392" } }),
      );
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("marks unread for planner assistant messages visible in the common Chat feed", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(
        message({
          role: "assistant",
          sessionId: "sess-planner",
          agentId: "task-planner:FN-7392",
          taskChatVisibleInCommonFeed: true,
        }),
      );
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });

  it("ignores planner user messages", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(
        message({ role: "user", sessionId: "sess-planner", agentId: "task-planner:FN-7392" }),
      );
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("ignores user-role messages", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "user" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("ignores assistant messages while the chat view is open", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "chat", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("ignores assistant messages while quick chat is open", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: true }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("clears the unread flag once the chat view opens", () => {
    const { result, rerender } = renderHook(
      ({ taskView }: { taskView: TaskView }) =>
        useChatUnreadBadge(undefined, { taskView, quickChatOpen: false }),
      { initialProps: { taskView: "board" } },
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant" }));
    });
    expect(result.current.chatHasUnreadResponse).toBe(true);

    rerender({ taskView: "chat" });
    expect(result.current.chatHasUnreadResponse).toBe(false);
  });
  it("marks unread on a non-user chat:room:message:added", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:room:message:added"]?.(message({ role: "assistant" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });

  it("ignores user-role chat:room:message:added events", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:room:message:added"]?.(message({ role: "user" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("marks unread for assistant messages scoped to the current project", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge("p1", { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant", projectId: "p1" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });

  it("ignores assistant messages scoped to a different project", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge("p1", { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant", projectId: "p2" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });
  it("marks unread for assistant chat:room:message:added events scoped to the current project", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge("p1", { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:room:message:added"]?.(message({ role: "assistant", projectId: "p1" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(true);
  });

  it("ignores assistant chat:room:message:added events scoped to a different project", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge("p1", { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:room:message:added"]?.(message({ role: "assistant", projectId: "p2" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });

  it("ignores malformed unread event payloads", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge(undefined, { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.({ data: "{" } as MessageEvent);
      handlers["chat:room:message:added"]?.({ data: "not-json" } as MessageEvent);
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
  });
});
