import { describe, expect, it } from "vitest";
import { buildCompactedRoomTranscript, ChatManager } from "../chat.js";

function makeMessage(index: number, overrides: Partial<{
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  senderAgentId: string | null;
}> = {}) {
  return {
    id: overrides.id ?? `msg-${index}`,
    role: overrides.role ?? (index % 2 === 0 ? "user" : "assistant"),
    content: overrides.content ?? `message-${index}`,
    createdAt: overrides.createdAt ?? `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    senderAgentId: "senderAgentId" in overrides ? (overrides.senderAgentId ?? null) : (index % 2 === 0 ? null : "agent-a"),
  };
}

describe("buildCompactedRoomTranscript", () => {
  it("returns all messages verbatim when the transcript fits inside the recent window", () => {
    const messages = Array.from({ length: 6 }, (_, index) => makeMessage(index));

    const transcript = buildCompactedRoomTranscript(messages, "msg-4");

    expect(transcript).not.toContain("## Earlier room context (compacted)");
    expect(transcript).toContain("message-0");
    expect(transcript).toContain("message-5");
    expect(transcript.match(/\[LATEST USER MESSAGE — ANSWER THIS\]/g)).toHaveLength(1);
  });

  it("prepends a compacted summary and keeps the last 25 messages verbatim by default", () => {
    const messages = Array.from({ length: 30 }, (_, index) => {
      const olderUserLengths = [40, 80, 120, 160, 200, 220, 60, 70, 90];
      const content = index < 18 && index % 2 === 0
        ? `older-user-${index}-` + "u".repeat(olderUserLengths[index / 2] ?? 20)
        : `message-${index}`;
      return makeMessage(index, { content });
    });
    const latestUserMessageId = "msg-28";

    const transcript = buildCompactedRoomTranscript(messages, latestUserMessageId);

    expect(transcript).toContain("## Earlier room context (compacted)");
    expect(transcript).toContain("- Span: 5 messages from 2026-01-01T00:00:00.000Z to 2026-01-01T00:00:04.000Z");
    expect(transcript).toContain("- Participants: User, Agent agent-a");
    const [summaryBlock] = transcript.split("\n\n");
    const highlightLines = summaryBlock.split("\n").filter((line) => line.startsWith("  - "));
    expect(highlightLines).toHaveLength(5);
    const highlightTimestamps = highlightLines.map((line) => line.match(/\[(.*?)\]/)?.[1] ?? "");
    expect(highlightTimestamps).toEqual([...highlightTimestamps].sort());

    for (let index = 5; index < 30; index += 1) {
      expect(transcript).toContain(`- [2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z]`);
    }
    expect(transcript).not.toContain("- [2026-01-01T00:00:04.000Z] (user) User:");
    expect(transcript).toContain("(user) User: message-28 [LATEST USER MESSAGE — ANSWER THIS]");
  });

  it("preserves the latest marker exactly once even when the transcript must shrink", () => {
    const messages = Array.from({ length: 30 }, (_, index) => makeMessage(index, {
      role: index === 29 ? "user" : (index % 3 === 0 ? "assistant" : "user"),
      senderAgentId: index % 3 === 0 ? "agent-a" : null,
      content: `message-${index}-` + "x".repeat(1500),
    }));

    const transcript = buildCompactedRoomTranscript(messages, "msg-29");

    expect(transcript.length).toBeLessThanOrEqual(20000);
    expect(transcript.match(/\[LATEST USER MESSAGE — ANSWER THIS\]/g)).toHaveLength(1);
    expect(transcript).toContain("message-29-");
  });

  it("drops summary highlights from the bottom when the summary exceeds its cap", () => {
    const olderMessages = Array.from({ length: 18 }, (_, index) => makeMessage(index, {
      role: "user",
      content: `older-${index}-` + "z".repeat(500),
    }));
    const recentMessages = Array.from({ length: 12 }, (_, index) => makeMessage(index + 18, {
      role: index === 11 ? "user" : "assistant",
      senderAgentId: index === 11 ? null : `agent-${index}`,
      content: `recent-${index}`,
    }));

    const transcript = buildCompactedRoomTranscript([...olderMessages, ...recentMessages], "msg-29", { recentVerbatim: 12 });
    const [summaryBlock] = transcript.split("\n\n");
    const highlightLines = summaryBlock.split("\n").filter((line) => line.startsWith("  - "));

    expect(summaryBlock).toContain("## Earlier room context (compacted)");
    expect(summaryBlock).toContain("- Span: 18 messages");
    expect(summaryBlock).toContain("- Participants: User");
    expect(summaryBlock).toContain("- Highlights:");
    expect(summaryBlock.length).toBeLessThanOrEqual(3000);
    expect(highlightLines.length).toBeLessThanOrEqual(5);
  });

  it("keeps the total transcript under the overall cap", () => {
    const messages = Array.from({ length: 80 }, (_, index) => makeMessage(index, {
      role: index === 79 ? "user" : (index % 4 === 0 ? "system" : index % 2 === 0 ? "assistant" : "user"),
      senderAgentId: index % 2 === 0 && index % 4 !== 0 ? `agent-${index}` : null,
      content: `message-${index}-` + "q".repeat(4000),
    }));

    const transcript = buildCompactedRoomTranscript(messages, "msg-79");

    expect(transcript.length).toBeLessThanOrEqual(20000);
    expect(transcript).toContain("message-79-");
  });

  it("supports recentVerbatim override via opts", () => {
    const messages = Array.from({ length: 10 }, (_, index) => makeMessage(index));

    const transcript = buildCompactedRoomTranscript(messages, "msg-8", { recentVerbatim: 4 });

    expect(transcript).toContain("## Earlier room context (compacted)");
    expect(transcript).toContain("- Span: 6 messages");
    expect(transcript).not.toContain("- [2026-01-01T00:00:00.000Z] (user) User: message-0");
    for (let index = 6; index < 10; index += 1) {
      expect(transcript).toContain(`- [2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z]`);
    }
  });

  it("supports summaryMaxChars override via opts", () => {
    const olderMessages = Array.from({ length: 18 }, (_, index) => makeMessage(index, {
      role: "user",
      content: `older-${index}-` + "z".repeat(500),
    }));
    const recentMessages = Array.from({ length: 12 }, (_, index) => makeMessage(index + 18, {
      role: index === 11 ? "user" : "assistant",
      senderAgentId: index === 11 ? null : `agent-${index}`,
      content: `recent-${index}`,
    }));

    const transcript = buildCompactedRoomTranscript([...olderMessages, ...recentMessages], "msg-29", { summaryMaxChars: 200 });
    const [summaryBlock] = transcript.split("\n\n");

    expect(summaryBlock.length).toBeLessThanOrEqual(200);
    expect(summaryBlock).toContain("## Earlier room context (compacted)");
  });

  it("falls back to defaults when room compaction settings are invalid", async () => {
    const manager = new ChatManager({} as any, "/tmp", undefined, undefined, async () => ({
      fallbackProvider: undefined,
      fallbackModelId: undefined,
      defaultProvider: undefined,
      defaultModelId: undefined,
      chatRoomRecentVerbatimMessages: 0,
      chatRoomCompactionFetchLimit: -1,
      chatRoomSummaryMaxChars: Number.NaN,
    }));

    const settings = await (manager as any).getRoomCompactionSettings();
    expect(settings).toEqual({ recentVerbatim: 25, fetchLimit: 200, summaryMaxChars: 3000 });

    const managerWithThrow = new ChatManager({} as any, "/tmp", undefined, undefined, async () => {
      throw new Error("boom");
    });
    const fallbackSettings = await (managerWithThrow as any).getRoomCompactionSettings();
    expect(fallbackSettings).toEqual({ recentVerbatim: 25, fetchLimit: 200, summaryMaxChars: 3000 });
  });

  it("computes unique participant labels from older messages", () => {
    const older = [
      makeMessage(0, { role: "user", senderAgentId: null, content: "user older" }),
      makeMessage(1, { role: "assistant", senderAgentId: "agent-a", content: "agent a older" }),
      makeMessage(2, { role: "system", senderAgentId: null, content: "system older" }),
      makeMessage(3, { role: "assistant", senderAgentId: null, content: "assistant older" }),
      makeMessage(4, { role: "assistant", senderAgentId: "agent-b", content: "agent b older" }),
    ];
    const recent = Array.from({ length: 12 }, (_, index) => makeMessage(index + 5, {
      role: index === 11 ? "user" : "assistant",
      senderAgentId: index === 11 ? null : "agent-c",
      content: `recent-${index}`,
    }));

    const transcript = buildCompactedRoomTranscript([...older, ...recent], "msg-16", { recentVerbatim: 12 });

    expect(transcript).toContain("- Participants: User, Agent agent-a, System, Assistant, Agent agent-b");
  });
});
