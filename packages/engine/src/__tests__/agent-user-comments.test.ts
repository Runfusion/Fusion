import { describe, expect, it } from "vitest";
import type { TaskComment } from "@fusion/core";
import { buildUserCommentsPromptSection, selectUserCommentsForAgentContext } from "../agents/agent-user-comments.js";

function comment(overrides: Partial<TaskComment>): TaskComment {
  return {
    id: overrides.id ?? "c1",
    text: overrides.text ?? "Please keep the old API export",
    author: overrides.author ?? "user",
    createdAt: overrides.createdAt ?? "2026-06-21T10:00:00.000Z",
    updatedAt: overrides.updatedAt,
  };
}

describe("agent user comments prompt helper", () => {
  it("returns no comments and no section for undefined comments", () => {
    const selected = selectUserCommentsForAgentContext({});

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("returns no comments and no section for an empty comment array", () => {
    const selected = selectUserCommentsForAgentContext({ comments: [] });

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("filters out agent-authored comments", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "agent-1", author: "agent", text: "internal note" })],
    });

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("formats populated user comments with author, timestamp, and text", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "user-1", text: "Please keep the old API export", createdAt: "2026-06-21T12:34:00.000Z" })],
    });

    const section = buildUserCommentsPromptSection(selected);

    expect(section).toContain("## User Comments");
    expect(section).toContain("**user** — 2026-06-21T12:34:00.000Z");
    expect(section).toContain("> Please keep the old API export");
  });

  it("selects user-authored legacy steering comments alongside unified comments", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "c-user", text: "Unified user requirement", createdAt: "2026-06-21T10:00:00.000Z" })],
      steeringComments: [
        { id: "s-user", text: "Legacy steering requirement", author: "user", createdAt: "2026-06-21T10:05:00.000Z" },
        { id: "s-agent", text: "agent-only steering", author: "agent", createdAt: "2026-06-21T10:06:00.000Z" },
      ],
    });

    expect(selected.map((c) => c.id)).toEqual(["c-user", "s-user"]);
    const section = buildUserCommentsPromptSection(selected);
    expect(section).toContain("Unified user requirement");
    expect(section).toContain("Legacy steering requirement");
    expect(section).not.toContain("agent-only steering");
  });

  it("dedupes duplicate ids across unified comments and legacy steering comments", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "dup", text: "unified duplicate", createdAt: "2026-06-21T10:00:00.000Z" })],
      steeringComments: [
        { id: "dup", text: "steering duplicate wins", author: "user", createdAt: "2026-06-21T11:00:00.000Z" },
      ],
    });

    const section = buildUserCommentsPromptSection(selected);

    expect(selected).toHaveLength(1);
    expect(section).toContain("steering duplicate wins");
    expect(section).not.toContain("unified duplicate");
  });

  it("preserves multiline text when formatting selected comments and steering", () => {
    const selected = selectUserCommentsForAgentContext({
      steeringComments: [
        { id: "s-multiline", text: "Line one\nLine two", author: "user", createdAt: "2026-06-21T10:00:00.000Z" },
      ],
    });

    expect(buildUserCommentsPromptSection(selected)).toContain("> Line one\n> Line two");
  });

  it("caps a large mixed history to the requested newest comments in chronological order", () => {
    const comments = Array.from({ length: 15 }, (_, index) => comment({
      id: `user-${index}`,
      text: `comment ${index}`,
      createdAt: `2026-06-21T10:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const steeringComments = Array.from({ length: 15 }, (_, index) => ({
      id: `steer-${index}`,
      text: `steering ${index}`,
      author: "user" as const,
      createdAt: `2026-06-21T11:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    const selected = selectUserCommentsForAgentContext({ comments, steeringComments }, { limit: 3 });
    const section = buildUserCommentsPromptSection(selected);

    expect(selected.map((c) => c.id)).toEqual(["steer-12", "steer-13", "steer-14"]);
    expect(section).not.toContain("steering 11");
    expect(section.indexOf("steering 12")).toBeLessThan(section.indexOf("steering 13"));
    expect(section.indexOf("steering 13")).toBeLessThan(section.indexOf("steering 14"));
  });

  it("returns all user comments and steering entries when reviewer callers request uncapped context", () => {
    const comments = Array.from({ length: 15 }, (_, index) => comment({
      id: `user-${index}`,
      text: `comment ${index}`,
      createdAt: `2026-06-21T10:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const steeringComments = Array.from({ length: 15 }, (_, index) => ({
      id: `steer-${index}`,
      text: `steering ${index}`,
      author: "user" as const,
      createdAt: `2026-06-21T11:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    const selected = selectUserCommentsForAgentContext({ comments, steeringComments }, { limit: null });
    const section = buildUserCommentsPromptSection(selected);

    expect(selected).toHaveLength(30);
    expect(selected[0]?.id).toBe("user-0");
    expect(selected.at(-1)?.id).toBe("steer-14");
    expect(section).toContain("comment 0");
    expect(section).toContain("steering 14");
  });
});
