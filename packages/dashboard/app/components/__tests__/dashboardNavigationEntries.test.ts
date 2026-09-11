import { describe, expect, it, vi } from "vitest";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

const base = { view: "board" as const, onChangeView: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, showSkills: true, flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true } };

describe("dashboardNavigationEntries", () => {
  it("classe explicitement les destinations sans dupliquer History, Chat ou Notes", () => {
    const entries = buildDashboardNavigationEntries(base);
    expect(entries.every((entry) => ["main-page", "existing-action", "external-owner"].includes(entry.kind))).toBe(true);
    expect(entries.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["patchnode", "chat", "notes"]));
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["command-center", "board", "list", "planning", "missions", "agents", "mailbox", "new-task"]);
    expect(entries.filter((entry) => entry.kind === "external-owner").map((entry) => entry.id)).toEqual(["dev-server", "secrets", "pull-requests"]);
    expect(entries.filter((entry) => entry.placement !== "external").every((entry) => typeof entry.onSelect === "function")).toBe(true);
  });

  it("conserve les gates et route chaque catégorie vers son propriétaire", async () => {
    const entries = buildDashboardNavigationEntries({ ...base, showAgents: false, showSkills: false, flags: {} });
    expect(entries.some((entry) => entry.id === "agents" || entry.id === "skills" || entry.id === "memory")).toBe(false);
    entries.find((entry) => entry.id === "planning")?.onSelect?.();
    entries.find((entry) => entry.id === "new-task")?.onSelect?.();
    expect(base.onChangeView).toHaveBeenCalledWith("planning");
    expect(base.onNewTask).toHaveBeenCalledTimes(1);
  });
});
