import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordResumeEvent = vi.fn();
const subscribeCalls: Array<{ onReconnect?: () => void }> = [];

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, handlers: { onReconnect?: () => void }) => {
    subscribeCalls.push({ onReconnect: handlers.onReconnect });
    return () => {};
  },
}));

vi.mock("../../api", () => ({
  fetchChatRooms: vi.fn().mockResolvedValue({ rooms: [] }),
  createChatRoom: vi.fn(),
  fetchChatRoomMembers: vi.fn().mockResolvedValue({ members: [] }),
  fetchChatRoomMessages: vi.fn().mockResolvedValue({ messages: [] }),
  deleteChatRoom: vi.fn(),
  postChatRoomMessage: vi.fn(),
  uploadChatRoomAttachment: vi.fn(),
  clearChatRoomMessages: vi.fn(),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

describe("useChatRooms resume instrumentation", () => {
  beforeEach(() => {
    subscribeCalls.length = 0;
    recordResumeEvent.mockReset();
  });

  it("records sse-reconnect trigger on reconnect callback", async () => {
    const { useChatRooms } = await import("../useChatRooms");
    renderHook(() => useChatRooms("proj-1"));

    await waitFor(() => {
      expect(subscribeCalls[0]?.onReconnect).toBeTypeOf("function");
    });

    act(() => {
      subscribeCalls[0]?.onReconnect?.();
    });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useChatRooms",
      trigger: "sse-reconnect",
      projectId: "proj-1",
      replayAttempted: false,
    }));
  });
});
