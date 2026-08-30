import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
  updateChatSession: vi.fn(),
}));

import { updateChatSession } from "../../api";
import { CHAT_COMMANDS, filterChatCommands, matchChatCommand, selectChatCommands } from "../chat-commands";

const mockUpdateChatSession = vi.mocked(updateChatSession);

/*
FNXC:ChatMemoryFocusFocusCommandTest 2026-08-13:
/focus registers in the shared CHAT_COMMANDS
registry, matches at text start only, and its run() persists the per-conversation
topic via updateChatSession. It must be dispatchable regardless of a running agent
(requiresAgent: false), because /focus is a local session-setting command — the
recall scoping it controls is a WITHIN-project read filter enforced server-side,
never disabled by agent state.
*/

describe("focus slash command", () => {
  beforeEach(() => {
    mockUpdateChatSession.mockReset();
  });

  it("registers a /focus command that does not require a running agent", () => {
    const focus = CHAT_COMMANDS.find((command) => command.name === "focus");
    expect(focus).toBeDefined();
    expect(focus?.trigger).toBe("/focus");
    expect(focus?.requiresAgent).toBe(false);
    expect(focus?.description).toContain("whole-project");
  });

  it("matches /focus <topic> at text start only and extracts the trimmed remainder", () => {
    const match = matchChatCommand("/focus auth-northstar");
    expect(match).not.toBeNull();
    expect(match?.command.name).toBe("focus");
    expect(match?.remainder).toBe("auth-northstar");

    const trimmed = matchChatCommand("/focus   auth-northstar   ");
    expect(trimmed?.remainder).toBe("auth-northstar");

    // Trigger alone (no remainder) is not dispatchable.
    expect(matchChatCommand("/focus")).toBeNull();
    // Mid-message occurrences are not dispatchable.
    expect(matchChatCommand("please /focus auth-northstar")).toBeNull();
  });

  it("filterChatCommands surfaces /focus alongside /steer", () => {
    const focus = filterChatCommands("foc");
    expect(focus.map((command) => command.name)).toEqual(["focus"]);
    const steer = filterChatCommands("ste");
    expect(steer.map((command) => command.name)).toEqual(["steer"]);
    // An empty filter returns every registered command.
    expect(filterChatCommands("")).toHaveLength(CHAT_COMMANDS.length);
  });

  it("withholds /focus from flag-off menus and dispatch while retaining /steer", () => {
    const disabled = selectChatCommands({ chatFocusEnabled: false });
    expect(disabled.map((command) => command.name)).toContain("steer");
    expect(disabled.map((command) => command.name)).not.toContain("focus");
    expect(matchChatCommand("/focus topic", disabled)).toBeNull();

    const enabled = selectChatCommands({ chatFocusEnabled: true });
    expect(enabled).toBe(CHAT_COMMANDS);
    expect(matchChatCommand("/focus topic", enabled)?.command.name).toBe("focus");
  });

  it("persists the topic via updateChatSession with the session id, topic, and project id", async () => {
    mockUpdateChatSession.mockResolvedValueOnce({ session: { id: "SES-1", memoryFocus: "auth-northstar" } } as any);
    const focus = CHAT_COMMANDS.find((command) => command.name === "focus")!;

    await focus.run({ taskId: "TASK-1", sessionId: "SES-1", projectId: "proj-123", remainder: "auth-northstar" });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("SES-1", { memoryFocus: "auth-northstar" }, "proj-123");
  });

  it("persists an 'all' remainder so recall returns to whole-project scope", async () => {
    mockUpdateChatSession.mockResolvedValueOnce({ session: { id: "SES-1", memoryFocus: "all" } } as any);
    const focus = CHAT_COMMANDS.find((command) => command.name === "focus")!;

    await focus.run({ taskId: "TASK-1", sessionId: "SES-1", projectId: "proj-123", remainder: "all" });

    expect(mockUpdateChatSession).toHaveBeenCalledWith("SES-1", { memoryFocus: "all" }, "proj-123");
  });

  it("propagates rejection so the caller can surface an error", async () => {
    mockUpdateChatSession.mockRejectedValueOnce(new Error("session gone"));
    const focus = CHAT_COMMANDS.find((command) => command.name === "focus")!;

    await expect(focus.run({ taskId: "TASK-1", sessionId: "SES-1", projectId: "proj-123", remainder: "topic" })).rejects.toThrow("session gone");
  });
})