import { describe, expect, it, vi } from "vitest";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

const base = { view: "board" as const, onChangeView: vi.fn(), onOpenPilot: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, showSkills: true, flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true } };

describe("dashboardNavigationEntries", () => {
  it("classe explicitement toutes les destinations et limite les fenêtres aux pilotes", () => {
    const entries = buildDashboardNavigationEntries(base);
    expect(entries.every((entry) => ["pilot-window", "main-page", "existing-action", "external-owner"].includes(entry.kind))).toBe(true);
    expect(entries.filter((entry) => entry.kind === "pilot-window").map((entry) => entry.id)).toEqual(["patchnode", "notes"]);
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["command-center", "board", "list", "patchnode", "planning", "missions", "agents", "chat", "mailbox", "notes", "new-task"]);
    expect(entries.filter((entry) => entry.kind === "external-owner").map((entry) => entry.id)).toEqual(["dev-server", "secrets", "pull-requests"]);
    expect(entries.filter((entry) => entry.placement !== "external").every((entry) => typeof entry.onSelect === "function")).toBe(true);
  });

  it("conserve les gates et route chaque catégorie vers son propriétaire", async () => {
    const entries = buildDashboardNavigationEntries({ ...base, showAgents: false, showSkills: false, flags: {} });
    expect(entries.some((entry) => entry.id === "agents" || entry.id === "skills" || entry.id === "memory")).toBe(false);
    entries.find((entry) => entry.id === "patchnode")?.onSelect?.();
    entries.find((entry) => entry.id === "planning")?.onSelect?.();
    entries.find((entry) => entry.id === "new-task")?.onSelect?.();
    expect(base.onOpenPilot).toHaveBeenCalledWith("patchnode");
    expect(base.onChangeView).toHaveBeenCalledWith("planning");
    expect(base.onNewTask).toHaveBeenCalledTimes(1);
  });
});
