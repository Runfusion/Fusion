import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileNavBar } from "../MobileNavBar";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

import { fetchScripts } from "../../api";

function mockViewport(mode: "mobile" | "desktop") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const isMobileQuery = query === "(max-width: 768px)";
      const isTabletQuery = query === "(min-width: 769px) and (max-width: 1024px)";
      return {
        matches: mode === "mobile" ? isMobileQuery : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  modalOpen: false,
  onOpenSettings: vi.fn(),
  onOpenActivityLog: vi.fn(),
  onOpenMailbox: vi.fn(),
  mailboxUnreadCount: 0,
  onOpenGitManager: vi.fn(),
  onOpenWorkflowSteps: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  activePlanningSessionCount: 0,
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  onOpenQuickChat: vi.fn(),
  projectId: "proj_1",
});

describe("MobileNavBar", () => {
  beforeEach(() => {
    mockViewport("mobile");
  });

  it("renders seven tab buttons (tasks + agents + missions + chat + mailbox + skills + more) when showSkillsTab is true", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} />);

    expect(screen.getByTestId("mobile-nav-tab-tasks")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-agents")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-missions")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-chat")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-nav-tab-skills")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();
    expect(screen.getByTestId("mobile-nav-tab-more")).toBeDefined();
  });

  it("renders roadmaps tab when experimentalFeatures.roadmap is true", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ roadmap: true }} />);
    expect(screen.getByTestId("mobile-nav-tab-roadmaps")).toBeDefined();
  });

  it("keeps optional tabs within mobile top-level capacity by overflowing roadmaps into More", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={true} experimentalFeatures={{ roadmap: true }} />);

    expect(screen.getByTestId("mobile-nav-tab-skills")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-roadmaps")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-roadmaps")).toBeDefined();
  });

  it("moves skills into More when roadmaps is the active optional top-level tab", () => {
    render(<MobileNavBar {...createDefaultProps()} view="roadmaps" showSkillsTab={true} experimentalFeatures={{ roadmap: true }} />);

    expect(screen.getByTestId("mobile-nav-tab-roadmaps")).toBeDefined();
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-skills")).toBeDefined();
  });

  it("does not render skills tab when showSkillsTab is false", () => {
    render(<MobileNavBar {...createDefaultProps()} showSkillsTab={false} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("does not render skills tab when showSkillsTab is omitted", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
    expect(screen.queryByTestId("mobile-nav-tab-skills")).toBeNull();
  });

  it("active tab is highlighted for mailbox", () => {
    render(<MobileNavBar {...createDefaultProps()} view="mailbox" />);
    expect(screen.getByTestId("mobile-nav-tab-mailbox").className).toContain("mobile-nav-tab--active");
  });

  it("mailbox tab calls onChangeView with 'mailbox'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-mailbox"));
    expect(props.onChangeView).toHaveBeenCalledWith("mailbox");
  });

  it("agents tab calls onChangeView with 'agents'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-agents"));
    expect(props.onChangeView).toHaveBeenCalledWith("agents");
  });

  it("agents tab is active when view is 'agents'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="agents" />);
    expect(screen.getByTestId("mobile-nav-tab-agents").className).toContain("mobile-nav-tab--active");
  });

  it("shows mailbox unread badge when mailboxUnreadCount > 0", () => {
    render(<MobileNavBar {...createDefaultProps()} mailboxUnreadCount={5} />);
    const badge = screen.getByTestId("mobile-nav-tab-mailbox").querySelector(".mobile-nav-tab-badge");
    expect(badge).toBeDefined();
    expect(badge?.textContent).toBe("5");
  });

  it("tasks tab calls onChangeView with 'board' when coming from a non-tasks view", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="missions" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("tasks tab calls onChangeView with 'board' when already on board", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("board");
  });

  it("tasks tab calls onChangeView with 'list' when already on list", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="list" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-tasks"));
    expect(props.onChangeView).toHaveBeenCalledWith("list");
  });

  it("tasks tab is active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" />);
    expect(screen.getByTestId("mobile-nav-tab-tasks").className).toContain("mobile-nav-tab--active");
  });

  it("tasks tab is active when view is 'list'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="list" />);
    expect(screen.getByTestId("mobile-nav-tab-tasks").className).toContain("mobile-nav-tab--active");
  });

  it("missions tab calls onChangeView with 'missions'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-missions"));
    expect(props.onChangeView).toHaveBeenCalledWith("missions");
  });

  it("missions tab is active when view is 'missions'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="missions" />);
    expect(screen.getByTestId("mobile-nav-tab-missions").className).toContain("mobile-nav-tab--active");
  });

  it("missions tab is not active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" />);
    expect(screen.getByTestId("mobile-nav-tab-missions").className).not.toContain("mobile-nav-tab--active");
  });

  it("skills tab calls onChangeView with 'skills'", () => {
    const props = createDefaultProps();
    render(<MobileNavBar {...props} view="board" showSkillsTab={true} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-skills"));
    expect(props.onChangeView).toHaveBeenCalledWith("skills");
  });

  it("skills tab is active when view is 'skills'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="skills" showSkillsTab={true} />);
    expect(screen.getByTestId("mobile-nav-tab-skills").className).toContain("mobile-nav-tab--active");
  });

  it("skills tab is not active when view is 'board'", () => {
    render(<MobileNavBar {...createDefaultProps()} view="board" showSkillsTab={true} />);
    expect(screen.getByTestId("mobile-nav-tab-skills").className).not.toContain("mobile-nav-tab--active");
  });

  it("opens and toggles the more sheet", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).not.toBeNull();

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("sheet contains expected navigation items including activity log", () => {
    render(<MobileNavBar {...createDefaultProps()} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));

    expect(screen.getByTestId("mobile-more-item-mailbox")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-activity")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-git")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-terminal")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-files")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-planning")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-workflow")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-schedules")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-github")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-usage")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-projects")).toBeDefined();
    expect(screen.getByTestId("mobile-more-item-chat")).toBeDefined();
    expect(screen.queryByTestId("mobile-more-item-roadmaps")).toBeNull();
    expect(screen.queryByTestId("mobile-more-item-insights")).toBeNull();
    expect(screen.getByTestId("mobile-more-item-settings")).toBeDefined();
  });

  it("shows roadmaps in more sheet when experimentalFeatures.roadmap is true", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ roadmap: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-roadmaps")).toBeDefined();
  });

  it("shows insights in more sheet when experimentalFeatures.insights is true", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ insights: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-insights")).toBeDefined();
  });

  it("does not show memory in more sheet when memoryView is not enabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.queryByTestId("mobile-more-item-memory")).toBeNull();
  });

  it("shows memory in more sheet when memoryView is enabled", () => {
    render(<MobileNavBar {...createDefaultProps()} experimentalFeatures={{ memoryView: true }} />);
    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    expect(screen.getByTestId("mobile-more-item-memory")).toBeDefined();
  });

  it("insights item in more sheet calls onChangeView with 'insights'", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} experimentalFeatures={{ insights: true }} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-insights"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onChangeView).toHaveBeenCalledWith("insights");
  });

  it("activity log item in more sheet calls onOpenActivityLog", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-activity"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenActivityLog).toHaveBeenCalledOnce();
  });

  it("closes sheet and calls handler when item is clicked", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-settings"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  it("calls onViewAllProjects from the Projects more-sheet item", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-projects"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onViewAllProjects).toHaveBeenCalledOnce();
  });

  it("calls onOpenQuickChat from the Chat more-sheet item", () => {
    const props = createDefaultProps();
    const { container } = render(<MobileNavBar {...props} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.click(screen.getByTestId("mobile-more-item-chat"));

    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(props.onOpenQuickChat).toHaveBeenCalledOnce();
  });

  it("closes sheet on backdrop click", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    const backdrop = container.querySelector(".mobile-more-sheet-backdrop");
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop!);
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("closes sheet on Escape", async () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);

    fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });
  });

  it("returns null when modalOpen is true", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} modalOpen={true} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it("applies footer-visible class when footer is shown", () => {
    const { container } = render(<MobileNavBar {...createDefaultProps()} footerVisible={true} />);
    expect(container.querySelector(".mobile-nav-bar--with-footer")).not.toBeNull();
  });

  it("returns null on desktop viewport", () => {
    mockViewport("desktop");
    const { container } = render(<MobileNavBar {...createDefaultProps()} />);
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  describe("scripts submenu", () => {
    beforeEach(() => {
      vi.mocked(fetchScripts).mockReset();
    });

    it("terminal item has a split toggle that opens scripts submenu", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({});
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      const toggle = screen.getByTestId("mobile-more-terminal-split-toggle");
      expect(toggle).toBeDefined();

      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-scripts-manage")).toBeDefined();
      });
    });

    it("scripts are fetched when submenu opens", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
        test: "pnpm test",
      });
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-script-item-build")).toBeDefined();
        expect(screen.getByTestId("mobile-more-script-item-test")).toBeDefined();
      });
    });

    it("clicking a script item calls onRunScript and closes sheet", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
      });
      const props = createDefaultProps();
      const { container } = render(<MobileNavBar {...props} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-script-item-build")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mobile-more-script-item-build"));
      expect(props.onRunScript).toHaveBeenCalledWith("build", "pnpm build");
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("manage scripts button calls onOpenScripts and closes sheet", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({
        build: "pnpm build",
      });
      const props = createDefaultProps();
      const { container } = render(<MobileNavBar {...props} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        expect(screen.getByTestId("mobile-more-scripts-manage")).toBeDefined();
      });

      fireEvent.click(screen.getByTestId("mobile-more-scripts-manage"));
      expect(props.onOpenScripts).toHaveBeenCalledOnce();
      expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    });

    it("empty scripts state shows 'No scripts' item", async () => {
      vi.mocked(fetchScripts).mockResolvedValue({});
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      await waitFor(() => {
        const manageBtn = screen.getByTestId("mobile-more-scripts-manage");
        expect(manageBtn).toBeDefined();
        expect(manageBtn.textContent).toContain("No scripts — add one…");
      });
    });

    it("loading state shows spinner while fetching", async () => {
      let resolveFetch!: (value: Record<string, string>) => void;
      vi.mocked(fetchScripts).mockImplementation(
        () => new Promise((resolve) => { resolveFetch = resolve; }),
      );
      render(<MobileNavBar {...createDefaultProps()} />);

      fireEvent.click(screen.getByTestId("mobile-nav-tab-more"));
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));

      expect(screen.getByTestId("mobile-more-scripts-loading")).toBeDefined();

      // Resolve to clean up
      resolveFetch({});
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-more-scripts-loading")).toBeNull();
      });
    });
  });
});
