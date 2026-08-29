import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-resolver.js", () => ({
  getStore: vi.fn(),
}));

const { getStore } = await import("../project-resolver.js");
const { runGoalsCitations } = await import("../commands/goals.js");

describe("goals citations cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters by goal and since/until window", async () => {
    const listGoalCitations = vi.fn().mockReturnValue([
      {
        id: 2,
        goalId: "G-ONE",
        agentId: "executor",
        surface: "agent_log",
        sourceRef: "agentLog:2",
        snippet: "G-ONE cited",
        timestamp: "2026-05-01T00:00:00.000Z",
      },
    ]);
    vi.mocked(getStore).mockResolvedValue({ listGoalCitations } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runGoalsCitations(undefined, {
      goalId: "G-ONE",
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-31T23:59:59.000Z",
    });

    expect(listGoalCitations).toHaveBeenCalledWith({
      goalId: "G-ONE",
      agentId: undefined,
      surface: undefined,
      startTime: "2026-05-01T00:00:00.000Z",
      endTime: "2026-05-31T23:59:59.000Z",
      limit: 50,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "2026-05-01T00:00:00.000Z  G-ONE  executor  agent_log  agentLog:2",
    );
  });

  it("prints valid json with --json", async () => {
    const rows = [
      {
        id: 1,
        goalId: "G-JSON",
        agentId: "agent-1",
        surface: "task_document",
        sourceRef: "document:FN-1:plan:rev1",
        snippet: "G-JSON",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];
    vi.mocked(getStore).mockResolvedValue({ listGoalCitations: vi.fn().mockReturnValue(rows) } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runGoalsCitations(undefined, { json: true });

    const output = logSpy.mock.calls[0]?.[0];
    expect(() => JSON.parse(String(output))).not.toThrow();
    expect(JSON.parse(String(output))).toEqual(rows);
  });

  it("prints empty-state message when no matches", async () => {
    vi.mocked(getStore).mockResolvedValue({ listGoalCitations: vi.fn().mockReturnValue([]) } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runGoalsCitations(undefined, {});
    expect(logSpy).toHaveBeenCalledWith("No goal citations match the filter.");
  });
});
