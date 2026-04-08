// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSubtaskBreakdownState,
  subtaskStreamManager,
} from "./subtask-breakdown.js";

describe("subtask-breakdown stream buffering", () => {
  beforeEach(() => {
    __resetSubtaskBreakdownState();
  });

  it("buffers broadcast events and forwards ids to subscribers", () => {
    const sessionId = "subtask-session-1";
    const callback = vi.fn();

    const unsubscribe = subtaskStreamManager.subscribe(sessionId, callback);

    const firstId = subtaskStreamManager.broadcast(sessionId, {
      type: "thinking",
      data: "delta-1",
    });
    const secondId = subtaskStreamManager.broadcast(sessionId, {
      type: "subtasks",
      data: [
        {
          id: "subtask-1",
          title: "Title",
          description: "Description",
          suggestedSize: "S",
          dependsOn: [],
        },
      ],
    });

    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    expect(callback).toHaveBeenNthCalledWith(1, { type: "thinking", data: "delta-1" }, 1);
    expect(callback).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "subtasks" }), 2);

    const buffered = subtaskStreamManager.getBufferedEvents(sessionId, 1);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]).toMatchObject({ id: 2, event: "subtasks" });

    unsubscribe();
  });

  it("buffers complete events without subscribers", () => {
    const sessionId = "subtask-session-2";

    const eventId = subtaskStreamManager.broadcast(sessionId, { type: "complete" });

    expect(eventId).toBe(1);
    expect(subtaskStreamManager.getBufferedEvents(sessionId, 0)).toEqual([
      { id: 1, event: "complete", data: "{}" },
    ]);
  });

  it("clears subscriptions and buffered events on cleanupSession", () => {
    const sessionId = "subtask-session-3";
    const callback = vi.fn();

    subtaskStreamManager.subscribe(sessionId, callback);
    subtaskStreamManager.broadcast(sessionId, { type: "thinking", data: "delta" });

    expect(subtaskStreamManager.getBufferedEvents(sessionId, 0)).toHaveLength(1);

    subtaskStreamManager.cleanupSession(sessionId);

    expect(subtaskStreamManager.getBufferedEvents(sessionId, 0)).toEqual([]);
  });
});
