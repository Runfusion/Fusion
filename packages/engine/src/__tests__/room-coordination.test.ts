import type { ChatRoomMember, ChatRoomMessage } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  countActiveAgentMembers,
  decideRoomCoordination,
  detectTaskFilingIntent,
  renderRoomCoordinationPromptBlock,
} from "../triage-domain/room-coordination.js";

function roomMember(agentId: string | null): ChatRoomMember {
  return {
    roomId: "room-1",
    // cast for test-only simulation of nullable rows from external callers
    agentId: agentId as unknown as string,
    role: "member",
    addedAt: new Date().toISOString(),
  };
}

function roomMessage(id: string, content: string, senderAgentId: string | null = "agent-peer"): ChatRoomMessage {
  return {
    id,
    roomId: "room-1",
    role: senderAgentId ? "assistant" : "user",
    content,
    thinkingOutput: null,
    metadata: null,
    senderAgentId,
    mentions: [],
    createdAt: new Date().toISOString(),
  };
}

describe("room-coordination", () => {
  describe("detectTaskFilingIntent", () => {
    it("detects explicit task-filing intent with extracted subject", () => {
      const result = detectTaskFilingIntent("please file a task for the secrets-sync regression");
      expect(result.isTaskFilingIntent).toBe(true);
      expect(result.subject).toBe("the secrets-sync regression");
      expect(result.cues.length).toBeGreaterThan(0);
    });

    it.each([
      ["Can you create a task to fix the broken merge?", "fix the broken merge"],
      ["open a task about the new typecheck failure", "the new typecheck failure"],
      ["track this as a task", null],
      ["FILE A TASK: dashboard FAB regression.", "dashboard FAB regression"],
      ["create a task for it", "it"],
      ["create a task for FN-1234", "FN-1234"],
    ])("handles positive variants: %s", (content, expectedSubject) => {
      const result = detectTaskFilingIntent(content);
      expect(result.isTaskFilingIntent).toBe(true);
      if (expectedSubject === null) {
        expect([null, "this"]).toContain(result.subject);
      } else {
        expect(result.subject).toContain(expectedSubject);
      }
    });

    it.each([
      "file it",
      "create it now",
      "do that as a task",
      "this is a task list",
      "I filed the task report yesterday",
      "",
      "   ",
    ])("rejects non-intent content: %s", (content) => {
      const result = detectTaskFilingIntent(content);
      expect(result).toEqual({ isTaskFilingIntent: false, cues: [], subject: null });
    });

    it("returns true for past-tense phrasing trade-off", () => {
      const result = detectTaskFilingIntent("I filed a task earlier");
      expect(result.isTaskFilingIntent).toBe(true);
    });

    it("rejects oversized content", () => {
      const result = detectTaskFilingIntent(`create a task for ${"x".repeat(1000)}`);
      expect(result).toEqual({ isTaskFilingIntent: false, cues: [], subject: null });
    });
  });

  describe("countActiveAgentMembers", () => {
    it("counts unique active agent members", () => {
      expect(countActiveAgentMembers([roomMember("a1"), roomMember("a2"), roomMember("a3")])).toBe(3);
    });

    it("deduplicates duplicate agent ids", () => {
      expect(countActiveAgentMembers([roomMember("a1"), roomMember("a1"), roomMember("a2")])).toBe(2);
    });

    it("ignores non-agent members", () => {
      expect(countActiveAgentMembers([roomMember(null), roomMember("a1")])).toBe(1);
    });
  });

  describe("decideRoomCoordination", () => {
    const detection = detectTaskFilingIntent("please file a task for secrets sync");

    it("returns null for non-intent detection", () => {
      const result = decideRoomCoordination({
        detection: { isTaskFilingIntent: false, cues: [], subject: null },
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [],
        pendingSenderAgentId: null,
      });
      expect(result).toBeNull();
    });

    it("returns null for single-agent rooms", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1")],
        recentMessages: [],
        pendingSenderAgentId: null,
      });
      expect(result).toBeNull();
    });

    it("returns claim when no prior peer claim exists", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [roomMessage("m1", "hello", null)],
        pendingSenderAgentId: null,
      });
      expect(result?.branch).toBe("claim");
      expect(result?.priorClaimMessageId).toBeUndefined();
    });

    it("returns defer-suggested with prior peer claim", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [roomMessage("m1", "Claiming: filing task for secrets sync", "agent-peer")],
        pendingSenderAgentId: "agent-main",
      });
      expect(result?.branch).toBe("defer-suggested");
      expect(result?.priorClaimMessageId).toBe("m1");
      expect(result?.priorClaimSenderId).toBe("agent-peer");
    });

    it("returns defer-suggested with prior task announcement", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [roomMessage("m2", "Filed FN-9001 for the secrets-sync regression", "agent-peer")],
        pendingSenderAgentId: "agent-main",
      });
      expect(result?.branch).toBe("defer-suggested");
      expect(result?.priorTaskId).toBe("FN-9001");
    });

    it("does not defer to self-authored claim", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [roomMessage("m3", "Claiming: filing task for secrets sync", "agent-main")],
        pendingSenderAgentId: "agent-main",
      });
      expect(result?.branch).toBe("claim");
    });

    it("skips pending message itself from prior lookup", () => {
      const result = decideRoomCoordination({
        detection,
        members: [roomMember("a1"), roomMember("a2")],
        recentMessages: [roomMessage("pending", "Claiming: filing task for secrets sync", "agent-main")],
        pendingSenderAgentId: "agent-main",
      });
      expect(result?.branch).toBe("claim");
    });
  });

  describe("renderRoomCoordinationPromptBlock", () => {
    it("renders claim branch instructions with explicit guard references", () => {
      const lines = renderRoomCoordinationPromptBlock(
        {
          branch: "claim",
          memberCount: 3,
          detection: { isTaskFilingIntent: true, cues: ["file a task"], subject: "secrets-sync regression" },
        },
        { id: "m5" },
      );

      const block = lines.join("\n");
      expect(block).toContain("fn_post_room_message");
      expect(block).toContain("fn_task_create");
      expect(block).toContain("FN-4918");
      expect(block).toContain("FN-4829");
      expect(block).toContain("FN-5152");
      expect(block).toContain("FN-5220");
      expect(block).toContain("reply_to_message_id = m5");
    });

    it("renders defer branch with peer, message, and prior task id", () => {
      const lines = renderRoomCoordinationPromptBlock(
        {
          branch: "defer-suggested",
          memberCount: 2,
          detection: { isTaskFilingIntent: true, cues: ["create a task"], subject: "secrets-sync regression" },
          priorClaimMessageId: "m4",
          priorClaimSenderId: "agent-peer",
          priorTaskId: "FN-9042",
        },
        { id: "m6" },
      );

      const block = lines.join("\n");
      expect(block).toContain("agent-peer");
      expect(block).toContain("message m4");
      expect(block).toContain("FN-9042");
      expect(block).toContain("reply_to_message_id = m6");
    });
  });
});
