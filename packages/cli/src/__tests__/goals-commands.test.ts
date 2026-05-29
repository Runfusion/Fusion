import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../project-resolver.js", () => ({
  getStore: vi.fn(),
}));

const { getStore } = await import("../project-resolver.js");
const { runGoalsList, runGoalsCreate, runGoalsArchive } = await import("../commands/goals.js");

describe("goals commands", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  function mockStore(goalStore: Record<string, unknown>) {
    vi.mocked(getStore).mockResolvedValue({
      getGoalStore: () => goalStore,
    } as any);
  }

  it("runGoalsList prints empty-state when no goals", async () => {
    mockStore({
      listGoals: vi.fn().mockReturnValue([]),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runGoalsList()).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith("\n  No goals yet. Create one with: fn goals create\n");
  });

  it("runGoalsList prints rows and soft warning when active count is high", async () => {
    const listGoals = vi
      .fn()
      .mockReturnValueOnce([{ id: "G-001", title: "Goal one", status: "active", description: "desc" }])
      .mockReturnValueOnce([
        { id: "G-001", title: "Goal one", status: "active", description: "desc" },
        { id: "G-002", title: "Goal two", status: "active" },
        { id: "G-003", title: "Goal three", status: "active" },
      ]);
    mockStore({ listGoals });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runGoalsList()).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("G-001"));
    expect(logSpy).toHaveBeenCalledWith("  ⚠  3/5 active goals — soft warning at 3, hard cap at 5");
  });

  it("runGoalsCreate trims args and prints success", async () => {
    const createGoal = vi.fn().mockReturnValue({ id: "G-001", title: "Title", status: "active" });
    mockStore({
      createGoal,
      listGoals: vi.fn().mockReturnValue([{ id: "G-001", status: "active" }]),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runGoalsCreate("  Title ", "  Long desc  ");

    expect(createGoal).toHaveBeenCalledWith({ title: "Title", description: "Long desc" });
    expect(logSpy).toHaveBeenCalledWith("  ✓ Created G-001: Title");
  });

  it("runGoalsCreate handles active-goal cap error", async () => {
    mockStore({
      createGoal: vi.fn(() => {
        throw { code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: 5, currentActive: 5 };
      }),
      listGoals: vi.fn(),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runGoalsCreate("Title", "Desc")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("hard cap"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("5"));
  });

  it("runGoalsArchive rejects missing id", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runGoalsArchive(undefined)).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Usage: fn goals archive <id>");
  });

  it("runGoalsArchive archives valid id", async () => {
    const archiveGoal = vi.fn().mockReturnValue({ id: "G-001", title: "Goal", status: "archived" });
    mockStore({
      getGoal: vi.fn().mockReturnValue({ id: "G-001", title: "Goal", status: "active" }),
      archiveGoal,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runGoalsArchive("G-001");
    expect(archiveGoal).toHaveBeenCalledWith("G-001");
    expect(logSpy).toHaveBeenCalledWith("  ✓ Archived G-001: Goal");
  });

  it("runGoalsArchive exits successfully when already archived", async () => {
    mockStore({
      getGoal: vi.fn().mockReturnValue({ id: "G-001", title: "Goal", status: "archived" }),
      archiveGoal: vi.fn(),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runGoalsArchive("G-001")).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith("Goal G-001 is already archived");
  });

  it("runGoalsArchive prints not-found error", async () => {
    mockStore({
      getGoal: vi.fn().mockReturnValue(null),
      archiveGoal: vi.fn(),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runGoalsArchive("G-404")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Goal G-404 not found");
  });
});
