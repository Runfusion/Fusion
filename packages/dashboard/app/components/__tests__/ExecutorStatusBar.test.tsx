import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "fs";
import path from "path";
import { ExecutorStatusBar } from "../ExecutorStatusBar";

const viewportModeMock = vi.hoisted(() => ({ value: "desktop" as "desktop" | "tablet" | "mobile" }));
const mockFetchScripts = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => viewportModeMock.value,
}));

vi.mock("../../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

// Mock the useExecutorStats hook
vi.mock("../../hooks/useExecutorStats", () => ({
  useExecutorStats: vi.fn(),
}));

vi.mock("../EngineControlMenu", async () => {
  const React = await import("react");
  return {
    EngineControlMenu: React.forwardRef(function MockEngineControlMenu(_props: unknown, ref) {
      const [open, setOpen] = React.useState(false);
      React.useImperativeHandle(ref, () => ({
        open: () => setOpen(true),
        close: () => setOpen(false),
        toggle: () => setOpen((current) => !current),
      }));
      return (
        <div>
          <button type="button" data-testid="engine-control-menu-trigger" onClick={() => setOpen((current) => !current)}>Engine controls</button>
          {open ? <div role="menu" data-testid="engine-control-menu">Engine menu</div> : null}
        </div>
      );
    }),
  };
});

import { useExecutorStats } from "../../hooks/useExecutorStats";
import type { AiSessionSummary, ExecutorStats } from "../../api";

const mockUseExecutorStats = useExecutorStats as ReturnType<typeof vi.fn>;
const executorStatusBarCss = fs.readFileSync(path.join(__dirname, "../ExecutorStatusBar.css"), "utf-8");
const terminalLauncherCss = fs.readFileSync(path.join(__dirname, "../TerminalLauncher.css"), "utf-8");

function getCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function getCssRuleBlockByPattern(css: string, pattern: RegExp): string {
  const match = css.match(pattern);
  return match?.[1] ?? "";
}

function expectNoHardcodedColors(cssBlock: string): void {
  expect(cssBlock).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
}

/** Minimal empty task list used by tests that mock the hook. */
const emptyTasks: any[] = [];

function makeTask(id: string, column: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function getSegmentByLabel(label: string): HTMLElement {
  const labelElement = screen
    .getAllByText(label)
    .find((element) => element.classList.contains("executor-status-bar__label"));
  expect(labelElement).toBeTruthy();
  const segment = labelElement?.closest(".executor-status-bar__segment");
  expect(segment).toBeTruthy();
  return segment as HTMLElement;
}

function expectSegmentCount(label: string, count: string): void {
  expect(within(getSegmentByLabel(label)).getByText(count)).toBeInTheDocument();
}

function makeBackgroundSession(id: string, status: AiSessionSummary["status"]): AiSessionSummary {
  return {
    id,
    type: "planning",
    status,
    title: `Background ${id}`,
    projectId: "project-1",
    updatedAt: "2026-07-03T12:00:00.000Z",
  };
}

describe("ExecutorStatusBar", () => {
  const defaultStats: ExecutorStats = {
    runningTaskCount: 2,
    blockedTaskCount: 1,
    stuckTaskCount: 0,
    queuedTaskCount: 5,
    inReviewCount: 3,
    executorState: "running",
    maxConcurrent: 4,
    lastActivityAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    viewportModeMock.value = "desktop";
    mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
    vi.mocked(mockUseExecutorStats).mockReturnValue({
      stats: defaultStats,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("rendering", () => {
    it("renders all stat segments", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Running");
      expect(statusBar).toHaveTextContent("Blocked");
      expect(statusBar).toHaveTextContent("Queued");
      expect(statusBar).toHaveTextContent("In Review");
      expect(statusBar).not.toHaveTextContent("Done");
      expect(statusBar).not.toHaveTextContent("Escalated");
    });

    it.each(["desktop", "tablet"] as const)("associates every visible footer count with its label on %s", (viewportMode) => {
      viewportModeMock.value = viewportMode;
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: {
          ...defaultStats,
          queuedTaskCount: 9,
          runningTaskCount: 2,
          maxConcurrent: 4,
          stuckTaskCount: 1,
          blockedTaskCount: 2,
          inReviewCount: 1,
        },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      const tasks = [
        makeTask("FN-010", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask("FN-101", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-102", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-103", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-104", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-105", "todo", { blockedBy: "FN-010" }),
      ];

      render(
        <ExecutorStatusBar
          tasks={tasks as any[]}
          staleHighFanoutBlockerAgeThresholdMs={60 * 60 * 1000}
          backgroundSessions={[
            makeBackgroundSession("ai-1", "generating"),
            makeBackgroundSession("ai-2", "awaiting_input"),
          ]}
          backgroundGenerating={1}
          backgroundNeedsInput={1}
          onOpenBackgroundSession={vi.fn()}
          onDismissBackgroundSession={vi.fn()}
        />,
      );

      const statusBar = screen.getByRole("status");
      expectSegmentCount("Queued", "9");
      expectSegmentCount("Running", "2");
      expect(within(getSegmentByLabel("Running")).getByText("4")).toHaveClass("executor-status-bar__max");
      expectSegmentCount("Stuck", "1");
      expectSegmentCount("Blocked", "2");
      expectSegmentCount("In Review", "1");
      expect(statusBar).toHaveTextContent("Overlap queue");
      expect(statusBar).toHaveTextContent("FN-010 · 5 todo");
      expect(statusBar).not.toHaveTextContent("Done");
      expect(statusBar.firstElementChild).not.toHaveClass("executor-status-bar__divider");
      expect(statusBar.lastElementChild).toHaveClass("executor-status-bar__segment--engine-controls");
    });

    it("shows overlap bottleneck summary with stable tie-break ordering", () => {
      const tasks = [
        makeTask("FN-010", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask("FN-002", "in-review", { columnMovedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask("FN-101", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-102", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-103", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-104", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-105", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-201", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-202", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-203", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-204", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-205", "todo", { blockedBy: "FN-002" }),
      ];

      render(
        <ExecutorStatusBar
          tasks={tasks}
          staleHighFanoutBlockerAgeThresholdMs={60 * 60 * 1000}
        />,
      );

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Overlap queue");
      expect(statusBar).toHaveTextContent("FN-002 · 5 todo");
    });

    it("does not show overlap queue summary for ordinary chains below threshold", () => {
      const tasks = [
        makeTask("FN-500", "in-progress"),
        makeTask("FN-501", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-502", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-503", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-504", "todo", { dependencies: ["FN-500"] }),
      ];

      render(<ExecutorStatusBar tasks={tasks} />);

      expect(screen.getByRole("status")).not.toHaveTextContent("Escalated");
    });

    it("displays running task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("2");
    });

    it("displays max concurrent count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("/");
      expect(statusBar).toHaveTextContent("4");
    });

    it("displays blocked task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("1");
    });

    it("displays queued task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("5");
    });

    it("displays in-review count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("3");
    });

    it("renders the terminal launcher in the footer on desktop and opens terminal from the preserved toggle test id", async () => {
      const user = userEvent.setup();
      const onToggleTerminal = vi.fn();
      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={onToggleTerminal} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      await user.click(screen.getByTestId("terminal-toggle-btn"));

      expect(onToggleTerminal).toHaveBeenCalledTimes(1);
      await user.click(screen.getByTestId("scripts-btn"));

      expect(screen.getByTestId("scripts-btn")).toBeInTheDocument();
      expect(await screen.findByTestId("quick-scripts-dropdown")).toBeInTheDocument();
      await waitFor(() => expect(mockFetchScripts).toHaveBeenCalledWith(undefined));
    });

    it("keeps the footer terminal scripts chevron usable when scripts are empty", async () => {
      const user = userEvent.setup();
      mockFetchScripts.mockResolvedValueOnce({});

      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      await user.click(screen.getByTestId("scripts-btn"));

      expect(await screen.findByTestId("quick-scripts-empty")).toBeInTheDocument();
    });

    it("renders the peer Quick Chat and Terminal footer launchers on tablet", () => {
      viewportModeMock.value = "tablet";

      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          onToggleTerminal={vi.fn()}
          onOpenScripts={vi.fn()}
          onRunScript={vi.fn()}
          quickChatButtonMode="footer"
          onOpenQuickChat={vi.fn()}
        />,
      );

      expect(screen.getByTestId("executor-quick-chat-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("terminal-toggle-btn")).toBeInTheDocument();
    });

    it("renders the Quick Chat footer launcher beside Terminal when footer mode is enabled", async () => {
      const user = userEvent.setup();
      const onOpenQuickChat = vi.fn();

      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          onToggleTerminal={vi.fn()}
          onOpenScripts={vi.fn()}
          onRunScript={vi.fn()}
          quickChatButtonMode="footer"
          onOpenQuickChat={onOpenQuickChat}
        />,
      );

      expect(screen.getByTestId("executor-quick-chat-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      await user.click(screen.getByTestId("executor-quick-chat-launcher"));

      expect(onOpenQuickChat).toHaveBeenCalledTimes(1);
    });

    it("keeps Quick Chat and Terminal footer launchers on the same font and color tokens", () => {
      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          onToggleTerminal={vi.fn()}
          onOpenScripts={vi.fn()}
          onRunScript={vi.fn()}
          quickChatButtonMode="footer"
          onOpenQuickChat={vi.fn()}
        />,
      );

      const quickChatLauncher = screen.getByTestId("executor-quick-chat-launcher");
      const terminalLauncher = screen.getByTestId("terminal-toggle-btn");
      expect(quickChatLauncher).toHaveClass("executor-status-bar__footer-launcher");
      expect(terminalLauncher).toHaveClass("terminal-launcher__main");
      expect(screen.getByTestId("executor-quick-chat-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();

      const quickChatRule = getCssRuleBlock(executorStatusBarCss, ".executor-status-bar__footer-launcher");
      const quickChatHoverRule = getCssRuleBlock(executorStatusBarCss, ".executor-status-bar__footer-launcher:hover");
      const quickChatFocusRule = getCssRuleBlock(executorStatusBarCss, ".executor-status-bar__footer-launcher:focus-visible");
      const terminalFooterRule = getCssRuleBlock(terminalLauncherCss, ".terminal-launcher--footer");
      const terminalControlRule = getCssRuleBlockByPattern(
        terminalLauncherCss,
        /\.terminal-launcher--footer \.terminal-launcher__main,\s*\.terminal-launcher--footer \.terminal-launcher__chevron\s*\{([^}]*)\}/,
      );
      const terminalLabelRule = getCssRuleBlock(terminalLauncherCss, ".terminal-launcher--footer .terminal-launcher__label");
      const terminalHoverRule = getCssRuleBlockByPattern(
        terminalLauncherCss,
        /\.terminal-launcher--footer \.terminal-launcher__main:hover,\s*\.terminal-launcher--footer \.terminal-launcher__chevron:hover\s*\{([^}]*)\}/,
      );
      const terminalFocusRule = getCssRuleBlockByPattern(
        terminalLauncherCss,
        /\.terminal-launcher--footer \.terminal-launcher__main:focus-visible,\s*\.terminal-launcher--footer \.terminal-launcher__chevron:focus-visible\s*\{([^}]*)\}/,
      );

      expect(quickChatRule).toContain("color: inherit");
      expect(quickChatRule).toContain("font-family: var(--font-primary)");
      expect(quickChatRule).toContain("font-size: inherit");
      expect(quickChatRule).toContain("font-weight: 500");
      expect(quickChatRule).toContain("line-height: 1");
      expect(quickChatHoverRule).toContain("color: var(--text)");
      expect(quickChatFocusRule).toContain("box-shadow: var(--focus-ring-strong)");

      expect(terminalFooterRule).toContain("color: inherit");
      expect(terminalFooterRule).toContain("font-family: var(--font-primary)");
      expect(terminalFooterRule).toContain("font-size: inherit");
      expect(terminalFooterRule).toContain("font-weight: 500");
      expect(terminalFooterRule).toContain("line-height: 1");
      expect(terminalControlRule).toContain("color: inherit");
      expect(terminalControlRule).toContain("font-family: inherit");
      expect(terminalControlRule).toContain("font-size: inherit");
      expect(terminalControlRule).toContain("font-weight: inherit");
      expect(terminalControlRule).toContain("line-height: inherit");
      expect(terminalLabelRule).toContain("font-size: inherit");
      expect(terminalLabelRule).toContain("font-weight: inherit");
      expect(terminalLabelRule).toContain("line-height: inherit");
      expect(terminalHoverRule).toContain("color: var(--text)");
      expect(terminalFocusRule).toContain("box-shadow: var(--focus-ring-strong)");

      [quickChatRule, quickChatHoverRule, quickChatFocusRule, terminalFooterRule, terminalControlRule, terminalLabelRule, terminalHoverRule, terminalFocusRule].forEach(expectNoHardcodedColors);
    });

    it("omits the Quick Chat footer launcher for floating, off, and mobile modes", () => {
      const { rerender } = render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="floating"
          onOpenQuickChat={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();

      rerender(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="off"
          onOpenQuickChat={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();

      viewportModeMock.value = "mobile";
      rerender(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="footer"
          onOpenQuickChat={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();
    });

    it("omits the terminal launcher from the footer on mobile", () => {
      viewportModeMock.value = "mobile";

      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
    });

    it("does not show stuck tasks segment when count is 0", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Stuck")).not.toBeInTheDocument();
    });

    it("shows stuck tasks segment when count is > 0", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 2 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stuck");
      expect(statusBar).toHaveTextContent("2");
    });
  });

  describe("mobile stat tooltips", () => {
    const mobileStatIds = ["queued", "running", "blocked", "review"] as const;

    beforeEach(() => {
      viewportModeMock.value = "mobile";
    });

    it.each([
      ["queued", "Queued"],
      ["running", "Running"],
      ["blocked", "Blocked"],
      ["review", "In Review"],
    ] as const)("reveals the %s stat name on tap", async (id, label) => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      await user.click(screen.getByTestId(`executor-stat-${id}`));

      expect(screen.getByRole("tooltip")).toHaveTextContent(label);
      expect(screen.getByTestId(`executor-stat-${id}`)).toHaveAttribute("aria-expanded", "true");
    });

    it("uses the mobile-mode class and tap targets for mobile including short landscape", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar--mobile");
      mobileStatIds.forEach((id) => expect(screen.getByTestId(`executor-stat-${id}`)).toBeInTheDocument());
    });

    it("dismisses the tooltip on a second tap, outside tap, Escape, and scroll", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);
      const queued = screen.getByTestId("executor-stat-queued");

      await user.click(queued);
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      await user.click(queued);
      expect(screen.queryByRole("tooltip")).toBeNull();

      await user.click(queued);
      await user.click(document.body);
      expect(screen.queryByRole("tooltip")).toBeNull();

      await user.click(queued);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("tooltip")).toBeNull();

      await user.click(queued);
      act(() => window.dispatchEvent(new Event("scroll")));
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("portals the fixed tooltip outside the clipped footer", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);
      const statusBar = screen.getByRole("status");

      await user.click(screen.getByTestId("executor-stat-queued"));

      const tooltip = screen.getByRole("tooltip");
      expect(statusBar.contains(tooltip)).toBe(false);
      const tooltipRule = getCssRuleBlock(executorStatusBarCss, ".executor-status-bar__stat-tooltip");
      expect(tooltipRule).toContain("position: fixed");
      expect(tooltipRule).toContain("z-index: var(--z-popover, 60)");
      expectNoHardcodedColors(tooltipRule);
    });

    it("adds stat tooltips only for conditional segments that exist", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.queryByTestId("executor-stat-stuck")).toBeNull();
      expect(screen.queryByTestId("executor-stat-fanout")).toBeNull();

      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 1 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      const fanoutTasks = [
        makeTask("FN-010", "in-progress"),
        makeTask("FN-101", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-102", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-103", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-104", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-105", "todo", { blockedBy: "FN-010" }),
      ];
      rerender(<ExecutorStatusBar tasks={fanoutTasks} />);

      await user.click(screen.getByTestId("executor-stat-stuck"));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Stuck");
      await user.click(screen.getByTestId("executor-stat-fanout"));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Overlap queue");
    });

    it("keeps desktop and tablet labels inline without mobile tap controls", () => {
      viewportModeMock.value = "desktop";
      const { rerender } = render(<ExecutorStatusBar tasks={emptyTasks} />);

      const desktopStatus = screen.getByRole("status");
      expect(desktopStatus).not.toHaveClass("executor-status-bar--mobile");
      expect(getSegmentByLabel("Queued").tagName).toBe("DIV");
      expect(desktopStatus.querySelectorAll("button.executor-status-bar__segment--stat")).toHaveLength(0);

      viewportModeMock.value = "tablet";
      rerender(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.getByRole("status")).not.toHaveClass("executor-status-bar--mobile");
      expect(screen.getByRole("status").querySelectorAll("button.executor-status-bar__segment--stat")).toHaveLength(0);
    });

    it("keeps the label-hiding and tooltip styles tied to the mobile modifier", () => {
      const labelRule = getCssRuleBlock(executorStatusBarCss, ".executor-status-bar--mobile .executor-status-bar__label");
      expect(labelRule).toContain("display: none");
      expect(executorStatusBarCss).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.executor-status-bar__label\s*\{\s*display:\s*none/);
    });

    it("renders zero-count mobile stats without error", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, queuedTaskCount: 0, runningTaskCount: 0, blockedTaskCount: 0, inReviewCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);
      mobileStatIds.forEach((id) => expect(screen.getByTestId(`executor-stat-${id}`)).toBeInTheDocument());
    });
  });

  describe("executor state", () => {
    it("shows Running state with running executorState", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Running");
    });

    it("renders footer engine controls next to Running state and opens from the small trigger", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar.querySelector(".executor-status-bar__segment--engine-controls")).toHaveTextContent("Running");
      await user.click(screen.getByTestId("engine-control-menu-trigger"));

      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    });

    it("opens footer engine controls from the executor state text", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      await user.click(screen.getByTestId("executor-state-engine-control-trigger"));

      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    });

    it("shows Paused state with paused executorState", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "paused" },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Paused");
    });

    it("shows Idle state with idle executorState", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "idle", runningTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Idle");
    });

    it("shows Stopped state in error color without running class on desktop and mobile", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "stopped", runningTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      const { rerender } = render(<ExecutorStatusBar tasks={emptyTasks} />);

      const desktopStatusBar = screen.getByRole("status");
      const desktopStateElement = desktopStatusBar.querySelector(".executor-status-bar__state");
      const desktopStateIcon = screen.getByTestId("executor-state-engine-control-trigger").querySelector("svg");
      expect(desktopStateElement).toHaveTextContent("Stopped");
      expect(desktopStateElement).toHaveStyle({ color: "var(--color-error)" });
      expect(desktopStateIcon).toHaveStyle({ color: "var(--color-error)" });
      expect(desktopStatusBar).not.toHaveClass("executor-status-bar--running");

      viewportModeMock.value = "mobile";
      rerender(<ExecutorStatusBar tasks={emptyTasks} />);

      const mobileStatusBar = screen.getByRole("status");
      const mobileStateElement = mobileStatusBar.querySelector(".executor-status-bar__state");
      expect(mobileStateElement).toHaveTextContent("Stopped");
      expect(mobileStatusBar).not.toHaveClass("executor-status-bar--running");
    });

    it("applies running class when executor is running", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar--running");
    });

    it("does not apply running class when executor is paused", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "paused" },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).not.toHaveClass("executor-status-bar--running");
    });

    it("does not apply running class when executor is idle", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "idle", runningTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).not.toHaveClass("executor-status-bar--running");
    });
  });

  describe("loading state", () => {
    it("shows loading text when loading and no running tasks", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, runningTaskCount: 0 },
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByLabelText("Executor status");
      expect(statusBar).toHaveTextContent("Loading...");
      expect(statusBar).toHaveClass("executor-status-bar--loading");
    });

    it("renders the populated idle footer instead of loading when loaded data has zero running tasks", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "idle", runningTaskCount: 0, queuedTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Idle");
      expect(statusBar).toHaveTextContent("Queued");
      expect(statusBar).not.toHaveClass("executor-status-bar--loading");
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
      expect(screen.getByTestId("engine-control-menu-trigger")).toBeInTheDocument();
    });

    it("keeps an open concurrency popover mounted across idle heartbeat rerenders", async () => {
      const user = userEvent.setup();
      const idleStats = { ...defaultStats, executorState: "idle" as const, runningTaskCount: 0, queuedTaskCount: 0 };
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: idleStats,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      const { rerender } = render(<ExecutorStatusBar tasks={emptyTasks} lastFetchTimeMs={1000} />);

      await user.click(screen.getByTestId("engine-control-menu-trigger"));
      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();

      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...idleStats, lastActivityAt: "2026-06-27T21:40:00.000Z" },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      rerender(<ExecutorStatusBar tasks={[...emptyTasks]} lastFetchTimeMs={6000} />);

      expect(screen.getByRole("status")).not.toHaveClass("executor-status-bar--loading");
      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    });

    it("does not swap to loading or close the popover if a future idle heartbeat reports loading with data", async () => {
      viewportModeMock.value = "mobile";
      const user = userEvent.setup();
      const idleStats = { ...defaultStats, executorState: "idle" as const, runningTaskCount: 0, queuedTaskCount: 0 };
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: idleStats,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      const { rerender } = render(<ExecutorStatusBar tasks={emptyTasks} />);

      await user.click(screen.getByTestId("engine-control-menu-trigger"));
      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();

      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...idleStats, lastActivityAt: "2026-06-27T21:45:00.000Z" },
        loading: true,
        error: null,
        refresh: vi.fn(),
      });
      rerender(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Idle");
      expect(statusBar).not.toHaveClass("executor-status-bar--loading");
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    });

    it("does not show loading text when not loading", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    it("does not show loading text when loading but running tasks exist", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it.each(["desktop", "mobile"] as const)("keeps populated stats on %s when a transient stats-fetch blip is debounced", (viewportMode) => {
      viewportModeMock.value = viewportMode;
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Queued");
      expect(statusBar).toHaveTextContent("Running");
      expect(statusBar).toHaveTextContent("Blocked");
      expect(statusBar).toHaveTextContent("In Review");
      expect(statusBar).not.toHaveClass("executor-status-bar--connecting");
      expect(statusBar.querySelector(".executor-status-bar--connecting")).toBeNull();
      expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    });

    it("shows error message when error is present", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Stats unavailable",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stats unavailable");
      expect(statusBar).toHaveClass("executor-status-bar--error");
    });

    it.each(["desktop", "mobile"] as const)("shows connecting state for sustained suspension errors on %s", (viewportMode) => {
      viewportModeMock.value = viewportMode;
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Failed to fetch",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Connecting…");
      expect(statusBar).not.toHaveTextContent("Failed to fetch");
      expect(statusBar).toHaveClass("executor-status-bar--connecting");
    });

    it("does not show stat segments when error is present", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Failed to fetch stats",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      // The error bar shouldn't have the running segment
      expect(statusBar).not.toHaveTextContent("Running");
    });
  });

  describe("accessibility", () => {
    it("has role status", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("has aria-label", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Executor status");
    });

    it("applies warning class to blocked count when blocked tasks exist", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // Get the status bar and look for the blocked count element
      const statusBar = screen.getByRole("status");
      const blockedSegment = statusBar.querySelector(".executor-status-bar__indicator--blocked");
      expect(blockedSegment?.parentElement?.querySelector(".executor-status-bar__count")).toHaveClass("executor-status-bar__count--warning");
    });

    it("applies error class to stuck count when stuck tasks exist", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 1 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stuckSegment = statusBar.querySelector(".executor-status-bar__segment--stuck");
      expect(stuckSegment?.querySelector(".executor-status-bar__count")).toHaveClass("executor-status-bar__count--error");
    });

    it("applies active class to running indicator when tasks are running", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar--running");
    });
  });

  describe("visual states", () => {
    it("shows warning styling when blocked tasks exist", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const blockedCount = screen.getByText("1");
      expect(blockedCount).toHaveClass("executor-status-bar__count--warning");
    });

    it("does not show warning styling when no blocked tasks", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, blockedTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const counts = screen.queryAllByText("0");
      // First one is running count which shouldn't have warning
      // We need to check the blocked one specifically
    });
  });

  describe("project context", () => {
    it("passes tasks and projectId to useExecutorStats when provided", () => {
      const tasks: any[] = [{ id: "FN-001" }];
      render(<ExecutorStatusBar tasks={tasks} projectId="proj_abc123" />);

      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, "proj_abc123", undefined, undefined);
    });

    it("passes tasks and undefined to useExecutorStats when projectId not provided", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(mockUseExecutorStats).toHaveBeenCalledWith(emptyTasks, undefined, undefined, undefined);
    });
  });

  describe("project directory toggle", () => {
    it("reveals and hides the project path when the folder toggle is clicked", async () => {
      const user = userEvent.setup();
      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          currentProjectPath="/workspace/project"
          onOpenProjectDirectory={vi.fn()}
        />
      );

      expect(screen.queryByTestId("executor-project-path-link")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      expect(screen.getByTestId("executor-project-path-link")).toHaveTextContent("/workspace/project");

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      expect(screen.queryByTestId("executor-project-path-link")).not.toBeInTheDocument();
    });

    it("calls onOpenProjectDirectory when the visible project path is clicked", async () => {
      const user = userEvent.setup();
      const onOpenProjectDirectory = vi.fn();

      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          currentProjectPath="/workspace/project"
          onOpenProjectDirectory={onOpenProjectDirectory}
        />
      );

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      await user.click(screen.getByTestId("executor-project-path-link"));

      expect(onOpenProjectDirectory).toHaveBeenCalledTimes(1);
    });
  });

  describe("time display", () => {
    it("displays relative time for recent activity", () => {
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, lastActivityAt: twoMinutesAgo },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByText("2m ago")).toBeInTheDocument();
    });

    it("displays 'no activity' when lastActivityAt is undefined", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, lastActivityAt: undefined },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByText("no activity")).toBeInTheDocument();
    });
  });

  describe("board-sync regression", () => {
    it("requires tasks prop — does not fetch its own task list", () => {
      // This test verifies the component receives tasks from its parent
      // rather than creating its own useTasks instance, which was the
      // root cause of the footer/board count mismatch.
      const tasks: any[] = [{ id: "FN-001" }];
      render(<ExecutorStatusBar tasks={tasks} />);

      // useExecutorStats receives the tasks array as first argument
      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, undefined, undefined, undefined);
    });

    it("renders stuck segment with correct count when stuck tasks detected", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 3, runningTaskCount: 2 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stuck");
      const stuckCount = statusBar.querySelector(".executor-status-bar__segment--stuck .executor-status-bar__count");
      expect(stuckCount).toHaveTextContent("3");
      expect(stuckCount).toHaveClass("executor-status-bar__count--error");
    });
  });

  describe("mobile keyboard behavior", () => {
    it("hides bar when hideWhenKeyboardOpen is true", () => {
      const { container } = render(<ExecutorStatusBar tasks={emptyTasks} hideWhenKeyboardOpen={true} />);
      expect(container.firstChild).toBeNull();
    });

    it("applies keyboard-open class when keyboardOpen is true", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} keyboardOpen={true} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar--keyboard-open");
    });

    it("does not apply keyboard-open class and remains rendered when keyboardOpen is false", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} keyboardOpen={false} />);
      const status = screen.getByRole("status");
      expect(status).toBeInTheDocument();
      expect(status).not.toHaveClass("executor-status-bar--keyboard-open");
    });
  });

  describe("layout integration", () => {
    it("exposes stable executor-status-bar class for external layout hooks", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // The parent layout relies on the executor-status-bar class to detect
      // the footer's presence and set the --executor-footer-height CSS token.
      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar");
    });

    it("uses role=status for accessibility and layout targeting", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // The status role serves dual purpose: a11y landmark and a stable
      // selector for the project-content wrapper to detect footer presence.
      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveAttribute("aria-label", "Executor status");
    });

    it("always renders a root element with executor-status-bar class regardless of state", () => {
      // Test loading state
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: true,
        error: null,
        refresh: vi.fn(),
      });
      const { unmount } = render(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar");
      unmount();

      // Test error state
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Connection failed",
        refresh: vi.fn(),
      });
      render(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar");
    });
  });
});
