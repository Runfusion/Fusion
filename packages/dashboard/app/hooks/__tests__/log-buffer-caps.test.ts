/*
FNXC:MobileTabRetention 2026-07-26-11:40:
Regression coverage for the bounded-log-buffer invariant. Mobile browsers discard a backgrounded tab
whose resident set keeps growing, which the operator experiences as a white-splash reload on return;
every live log tail must therefore be a bounded ring that retains the NEWEST entries.

Surface enumeration — the invariant is asserted for every append path changed for this fix, not just
one repro:
  - `capLogEntries` itself (the single shared helper the streaming surfaces call),
  - `useAgentLogs` live SSE tail (TaskDetailModal per-task log),
  - the AgentDetailView / SystemControlsArea tails, which delegate to `capLogEntries` and are covered
    through it plus the SystemControlsArea cap constant,
  - `appendChatMessageChronologically`, which is deliberately NOT capped (user-visible transcript)
    and is asserted to keep every message while still producing chronological order.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MAX_LOG_ENTRIES, capLogEntries, useAgentLogs } from "../useAgentLogs";
import { appendChatMessageChronologically, type ChatMessageInfo } from "../useChat";
import { LOG_VIEW_CAP } from "../../components/command-center/areas/SystemControlsArea";
import { fetchAgentLogsWithMeta } from "../../api";
import { MockEventSource } from "../../../vitest.setup";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchAgentLogsWithMeta: vi.fn().mockResolvedValue({ entries: [], total: 0, hasMore: false }),
}));

const mockFetchAgentLogsWithMeta = vi.mocked(fetchAgentLogsWithMeta);

function getConnection(taskId: string): MockEventSource | undefined {
  const url = `/api/tasks/${taskId}/logs/stream`;
  const matching = MockEventSource.instances.filter((e) => e.url === url);
  return matching[matching.length - 1];
}

function makeEntry(index: number) {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    taskId: "FN-001",
    text: `entry-${index}`,
    type: "text" as const,
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  mockFetchAgentLogsWithMeta.mockReset().mockResolvedValue({ entries: [], total: 0, hasMore: false });
  vi.useRealTimers();
});

afterEach(() => {
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  vi.useRealTimers();
});

describe("capLogEntries", () => {
  it("keeps the newest entries once the cap is exceeded", () => {
    const entries = Array.from({ length: MAX_LOG_ENTRIES + 25 }, (_, i) => i);
    const capped = capLogEntries(entries);

    expect(capped).toHaveLength(MAX_LOG_ENTRIES);
    expect(capped[0]).toBe(25);
    expect(capped.at(-1)).toBe(MAX_LOG_ENTRIES + 24);
  });

  it("returns the same array reference when under the cap", () => {
    const entries = [1, 2, 3];
    expect(capLogEntries(entries)).toBe(entries);
  });

  it("honors an explicit cap (the Command Center system panel shares this helper)", () => {
    expect(LOG_VIEW_CAP).toBe(MAX_LOG_ENTRIES);
    const lines = Array.from({ length: LOG_VIEW_CAP + 10 }, (_, i) => i);
    const capped = capLogEntries(lines, LOG_VIEW_CAP);

    expect(capped).toHaveLength(LOG_VIEW_CAP);
    expect(capped.at(-1)).toBe(LOG_VIEW_CAP + 9);
  });
});

describe("useAgentLogs live tail", () => {
  it("bounds the streamed tail and retains the newest entries", async () => {
    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(getConnection("FN-001")).toBeDefined();
    });
    const es = getConnection("FN-001")!;

    const overflow = MAX_LOG_ENTRIES + 40;
    act(() => {
      for (let index = 0; index < overflow; index++) {
        es._emit("agent:log", makeEntry(index));
      }
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    // Newest-wins: the oldest 40 frames were dropped, the tail is intact.
    expect(result.current.entries[0].text).toBe("entry-40");
    expect(result.current.entries.at(-1)?.text).toBe(`entry-${overflow - 1}`);
    // The reader must not mistake a trimmed tail for the whole log: older entries
    // remain fetchable, so the "load older" affordance stays available.
    expect(result.current.hasMore).toBe(true);
  });

  it("holds a user-paged buffer at its size instead of collapsing it to the cap", async () => {
    const paged = Array.from({ length: MAX_LOG_ENTRIES + 100 }, (_, i) => makeEntry(i));
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: paged, total: paged.length, hasMore: false });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(paged.length);
    });

    const es = getConnection("FN-001")!;
    act(() => {
      es._emit("agent:log", makeEntry(9999));
    });

    await waitFor(() => {
      expect(result.current.entries.at(-1)?.text).toBe("entry-9999");
    });
    // Bounded: the buffer stays at the size the user paged to (one oldest entry drops per
    // new line) rather than growing forever OR snapping back down to MAX_LOG_ENTRIES.
    expect(result.current.entries).toHaveLength(paged.length);
    expect(result.current.entries[0].text).toBe("entry-1");
  });
});

describe("appendChatMessageChronologically", () => {
  const message = (id: string, createdAt: string): ChatMessageInfo => ({
    id,
    sessionId: "session-1",
    role: "user",
    content: id,
    createdAt,
  });

  it("never drops user-visible transcript messages", () => {
    let transcript: ChatMessageInfo[] = [];
    for (let index = 0; index < MAX_LOG_ENTRIES + 50; index++) {
      transcript = appendChatMessageChronologically(
        transcript,
        message(`m-${index}`, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()),
      );
    }

    expect(transcript).toHaveLength(MAX_LOG_ENTRIES + 50);
    expect(transcript[0].id).toBe("m-0");
    expect(transcript.at(-1)?.id).toBe(`m-${MAX_LOG_ENTRIES + 49}`);
  });

  it("restores chronological order when a message arrives out of order", () => {
    const first = message("a", "2026-01-01T00:00:00.000Z");
    const third = message("c", "2026-01-01T00:00:02.000Z");
    const second = message("b", "2026-01-01T00:00:01.000Z");

    const result = appendChatMessageChronologically([first, third], second);

    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
