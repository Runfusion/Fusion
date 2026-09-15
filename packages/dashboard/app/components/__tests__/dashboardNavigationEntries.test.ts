import { describe, expect, it, vi } from "vitest";
import { buildDashboardNavigationEntries } from "../dashboardNavigationEntries";

const base = { view: "board" as const, onChangeView: vi.fn(), onNewTask: vi.fn(), onOpenSettings: vi.fn(), showAgents: true, showSkills: true, flags: { memory: true, whiteboard: true, goals: true, insights: true, research: true, ideation: true, evals: true } };

describe("dashboardNavigationEntries", () => {
  it("classe explicitement les destinations sans dupliquer History ou Notes", () => {
    const entries = buildDashboardNavigationEntries(base);
    expect(entries.every((entry) => ["main-page", "existing-action", "external-owner"].includes(entry.kind))).toBe(true);
    /*
     * FN-426: no destination may be owned by the right dock any more, because the dock is optional and default-off.
     * The `external-owner` tier is therefore empty, and the tools it used to declare are real destinations (Files,
     * Git, Dev Server) or sections of another owner (Pull Requests inside Git, Secrets inside Settings).
     */
    expect(entries.filter((entry) => entry.kind === "external-owner")).toEqual([]);
    expect(entries.some((entry) => entry.id === "secrets" || entry.id === "pull-requests")).toBe(false);
    /* FNXC:DesktopNavigation 2026-09-15-07:00: Chat is a footer page again on operator request; Notes and List stay dock-only. */
    expect(entries.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["patchnode", "notes"]));
    // FN-382: List is a right-dock tool on every host that consumes this registry, so it is no longer a page entry.
    expect(entries.filter((entry) => entry.placement === "direct").map((entry) => entry.id)).toEqual(["command-center", "board", "planning", "missions", "agents", "chat", "mailbox"]);
    expect(entries.some((entry) => entry.id === "list")).toBe(false);
    expect(entries.find((entry) => entry.id === "settings")?.placement).toBe("external");
    expect(entries.filter((entry) => entry.placement !== "external").every((entry) => typeof entry.onSelect === "function")).toBe(true);
  });

  /* FN-426: Files and Git are ordinary destinations that navigate through the shared view owner, like any other page. */
  it("offre Files et Git comme destinations principales routées par onChangeView", () => {
    const onChangeView = vi.fn();
    const entries = buildDashboardNavigationEntries({ ...base, onChangeView, showDevServer: true });
    const files = entries.find((entry) => entry.id === "files");
    const git = entries.find((entry) => entry.id === "git-manager");
    expect(files?.kind).toBe("main-page");
    expect(files?.view).toBe("files");
    expect(git?.kind).toBe("main-page");
    expect(git?.view).toBe("git-manager");
    files?.onSelect?.();
    git?.onSelect?.();
    expect(onChangeView).toHaveBeenNthCalledWith(1, "files");
    expect(onChangeView).toHaveBeenNthCalledWith(2, "git-manager");
    expect(entries.some((entry) => entry.id === "dev-server")).toBe(true);
  });

  it("reflète l'état non lu de Chat sur l'entrée du footer et navigue vers la route chat", () => {
    const withUnread = buildDashboardNavigationEntries({ ...base, chatHasUnreadResponse: true });
    expect(withUnread.find((entry) => entry.id === "chat")?.dot).toBe("pending");
    const onChangeView = vi.fn();
    buildDashboardNavigationEntries({ ...base, onChangeView }).find((entry) => entry.id === "chat")?.onSelect?.();
    expect(onChangeView).toHaveBeenCalledWith("chat");
  });

  it("n'affiche pas la pastille non lue de Chat sur la route Chat active", () => {
    const entries = buildDashboardNavigationEntries({ ...base, view: "chat" as const, chatHasUnreadResponse: true });
    expect(entries.find((entry) => entry.id === "chat")?.dot).toBeUndefined();
  });

  it("conserve les gates et route chaque catégorie vers son propriétaire", async () => {
    const entries = buildDashboardNavigationEntries({ ...base, showAgents: false, showSkills: false, flags: {} });
    expect(entries.some((entry) => entry.id === "agents" || entry.id === "skills" || entry.id === "memory")).toBe(false);
    /* FN-426: Dev Server stays gated by its experimental flag, now in primary navigation instead of the dock. */
    expect(entries.some((entry) => entry.id === "dev-server")).toBe(false);
    entries.find((entry) => entry.id === "planning")?.onSelect?.();
    expect(entries.find((entry) => entry.id === "new-task")).toBeUndefined();
    expect(base.onChangeView).toHaveBeenCalledWith("planning");
    expect(base.onNewTask).not.toHaveBeenCalled();
  });
});
