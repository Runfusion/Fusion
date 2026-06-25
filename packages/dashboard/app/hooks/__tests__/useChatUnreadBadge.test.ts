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

  it("ignores assistant messages scoped to a different project", () => {
    const { result } = renderHook(() =>
      useChatUnreadBadge("p1", { taskView: "board", quickChatOpen: false }),
    );

    act(() => {
      handlers["chat:message:added"]?.(message({ role: "assistant", projectId: "p2" }));
    });

    expect(result.current.chatHasUnreadResponse).toBe(false);
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
});
