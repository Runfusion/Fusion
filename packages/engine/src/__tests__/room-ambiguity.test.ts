import type { ChatRoomMessage } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  detectDeicticReference,
  extractAntecedentCandidates,
  renderAmbiguityPromptBlock,
  scoreReferentConfidence,
  type AntecedentCandidate,
} from "../triage-domain/room-ambiguity.js";

function roomMessage(id: string, content: string, senderAgentId: string | null = "agent-1"): ChatRoomMessage {
  return {
    id,
    roomId: "room-1",
    role: "user",
    content,
    thinkingOutput: null,
    metadata: null,
    senderAgentId,
    mentions: [],
    createdAt: new Date().toISOString(),
  };
}

describe("room-ambiguity", () => {
  describe("detectDeicticReference", () => {
    it.each(["Yeah create it", "sure, do that", "ok make it"])(
      "detects positive deictic confirmation: %s",
      (content) => {
        const result = detectDeicticReference(content);
        expect(result.isDeictic).toBe(true);
        expect(result.cues.length).toBeGreaterThan(0);
      },
    );

    it.each([
      "create a task for FN-4861",
      "it should be a draft",
      "create it as a triage task",
    ])("rejects non-deictic/grounded message: %s", (content) => {
      const result = detectDeicticReference(content);
      expect(result).toEqual({ isDeictic: false, cues: [] });
    });
  });

  describe("extractAntecedentCandidates", () => {
    it("extracts FN ids and quoted titles from recent messages", () => {
      const candidates = extractAntecedentCandidates([
        roomMessage("m1", "Can we file FN-4861?"),
        roomMessage("m2", 'Let\'s create a task for "secrets-sync regression follow-up"'),
      ]);

      expect(candidates.map((candidate) => candidate.summary)).toEqual([
        "secrets-sync regression follow-up",
        "FN-4861",
      ]);
      expect(candidates[0]?.sourceMessageId).toBe("m2");
    });
  });

  describe("scoreReferentConfidence", () => {
    it("returns high for exactly one recent candidate", () => {
      const candidates: AntecedentCandidate[] = [
        {
          summary: "secrets sync regression",
          sourceMessageId: "m3",
          sourceSenderId: "agent-2",
          sourceIndexFromEnd: 2,
        },
      ];

      expect(scoreReferentConfidence(candidates)).toEqual({
        confidence: "high",
        resolved: candidates[0],
        candidates,
      });
    });

    it("returns low for multiple candidates", () => {
      const candidates: AntecedentCandidate[] = [
        {
          summary: "FN-1111",
          sourceMessageId: "m3",
          sourceSenderId: "agent-2",
          sourceIndexFromEnd: 1,
        },
        {
          summary: "docs task",
          sourceMessageId: "m4",
          sourceSenderId: "agent-3",
          sourceIndexFromEnd: 0,
        },
      ];

      expect(scoreReferentConfidence(candidates)).toEqual({ confidence: "low", candidates });
    });

    it("returns low for zero candidates", () => {
      expect(scoreReferentConfidence([])).toEqual({ confidence: "low", candidates: [] });
    });
  });

  describe("renderAmbiguityPromptBlock", () => {
    it("renders high-confidence resolved prompt block", () => {
      const lines = renderAmbiguityPromptBlock(
        {
          confidence: "high",
          resolved: {
            summary: "secrets sync regression",
            sourceMessageId: "m5",
            sourceSenderId: "agent-2",
            sourceIndexFromEnd: 0,
          },
        },
        { id: "m6" },
      );

      expect(lines[0]).toContain("Resolved Referent: secrets sync regression");
      expect(lines[0]).toContain("from message m5 by agent-2");
      expect(lines[0]).toContain("echo this exact subject");
    });

    it("renders low-confidence clarification prompt block with options", () => {
      const lines = renderAmbiguityPromptBlock(
        {
          confidence: "low",
          candidates: [
            {
              summary: "FN-1234",
              sourceMessageId: "m1",
              sourceSenderId: "agent-1",
              sourceIndexFromEnd: 1,
            },
            {
              summary: "docs task",
              sourceMessageId: "m2",
              sourceSenderId: null,
              sourceIndexFromEnd: 2,
            },
          ],
        },
        { id: "m9" },
      );

      expect(lines[0]).toContain("Do NOT create a task or spawn work");
      expect(lines[1]).toContain("1. FN-1234");
      expect(lines[2]).toContain("2. docs task");
      expect(lines[3]).toContain("Use reply_to_message_id = m9");
    });
  });
});
