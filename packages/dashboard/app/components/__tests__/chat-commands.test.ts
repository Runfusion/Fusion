import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
}));

import { addSteeringComment } from "../../api";
import { CHAT_COMMANDS, matchChatCommand, filterChatCommands, type ChatCommand } from "../chat-commands";

const mockAddSteeringComment = vi.mocked(addSteeringComment);

describe("chat-commands registry", () => {
  beforeEach(() => {
    mockAddSteeringComment.mockReset();
  });

  it("registers /steer as the first (and, today, only) command", () => {
    expect(CHAT_COMMANDS).toHaveLength(1);
    expect(CHAT_COMMANDS[0]).toMatchObject({
      trigger: "/steer",
      name: "steer",
    });
  });

  describe("matchChatCommand", () => {
    it("extracts the trigger and remainder for '/steer <text>'", () => {
      const match = matchChatCommand("/steer do X");
      expect(match).not.toBeNull();
      expect(match?.command.trigger).toBe("/steer");
      expect(match?.remainder).toBe("do X");
    });

    it("trims surrounding whitespace from the remainder", () => {
      const match = matchChatCommand("/steer   do X with extra spaces   ");
      expect(match?.remainder).toBe("do X with extra spaces");
    });

    it("does not match when the trigger has no remainder text", () => {
      expect(matchChatCommand("/steer")).toBeNull();
      expect(matchChatCommand("/steer ")).toBeNull();
      expect(matchChatCommand("/steer   ")).toBeNull();
    });

    it("does not match when the trigger appears mid-message", () => {
      expect(matchChatCommand("please /steer this task")).toBeNull();
      expect(matchChatCommand("hello /steer do X")).toBeNull();
    });

    it("does not match unrelated text or partial triggers", () => {
      expect(matchChatCommand("hello world")).toBeNull();
      expect(matchChatCommand("/steering do X")).toBeNull();
      expect(matchChatCommand("/ste do X")).toBeNull();
    });

    it("supports an injected command list for isolated testing", () => {
      const fakeCommand: ChatCommand = {
        trigger: "/retry",
        name: "retry",
        description: "test",
        run: vi.fn(),
      };
      const match = matchChatCommand("/retry now", [fakeCommand]);
      expect(match?.command).toBe(fakeCommand);
      expect(match?.remainder).toBe("now");
      expect(matchChatCommand("/steer now", [fakeCommand])).toBeNull();
    });
  });

  describe("filterChatCommands", () => {
    it("returns all commands when the filter is empty", () => {
      expect(filterChatCommands("")).toEqual(CHAT_COMMANDS);
      expect(filterChatCommands("   ")).toEqual(CHAT_COMMANDS);
    });

    it("matches by partial trigger or name, case-insensitively", () => {
      expect(filterChatCommands("ste")).toEqual(CHAT_COMMANDS);
      expect(filterChatCommands("STE")).toEqual(CHAT_COMMANDS);
      expect(filterChatCommands("steer")).toEqual(CHAT_COMMANDS);
    });

    it("returns an empty list when nothing matches", () => {
      expect(filterChatCommands("zzz")).toEqual([]);
    });
  });

  describe("run()", () => {
    it("steer calls addSteeringComment with taskId, remainder text, and projectId", async () => {
      mockAddSteeringComment.mockResolvedValueOnce({ id: "TASK-1" } as any);
      const steerCommand = CHAT_COMMANDS.find((command) => command.name === "steer")!;

      await steerCommand.run({ taskId: "TASK-1", projectId: "proj-123", remainder: "focus on the auth bug" });

      expect(mockAddSteeringComment).toHaveBeenCalledWith("TASK-1", "focus on the auth bug", "proj-123");
    });

    it("propagates rejection from addSteeringComment so callers can show an error", async () => {
      mockAddSteeringComment.mockRejectedValueOnce(new Error("network down"));
      const steerCommand = CHAT_COMMANDS.find((command) => command.name === "steer")!;

      await expect(steerCommand.run({ taskId: "TASK-1", remainder: "text" })).rejects.toThrow("network down");
    });
  });
});
