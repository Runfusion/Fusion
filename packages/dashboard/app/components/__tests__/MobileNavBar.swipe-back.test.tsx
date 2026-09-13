import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchScripts } from "../../api";
import { NavigationHistoryProvider, useNavigationHistory, type UseNavigationHistoryResult } from "../../hooks/useNavigationHistory";
import { MobileNavBar } from "../MobileNavBar";

vi.mock("../../api", () => ({
  fetchScripts: vi.fn(),
}));

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function HistoryHarness({ children, onReady }: { children: ReactNode; onReady: (history: UseNavigationHistoryResult) => void }) {
  const history = useNavigationHistory({ enabled: true });
  useEffect(() => onReady(history), [history, onReady]);
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

const createDefaultProps = () => ({
  view: "board" as const,
  onChangeView: vi.fn(),
  footerVisible: false,
  onOpenActivityLog: vi.fn(),
  onOpenGitManager: vi.fn(),
  onOpenWorkflowEditor: vi.fn(),
  onOpenSchedules: vi.fn(),
  onOpenScripts: vi.fn(),
  onToggleTerminal: vi.fn(),
  onOpenFiles: vi.fn(),
  onOpenGitHubImport: vi.fn(),
  onOpenPlanning: vi.fn(),
  onResumePlanning: vi.fn(),
  onOpenUsage: vi.fn(),
  onViewAllProjects: vi.fn(),
  onRunScript: vi.fn(),
  projectId: "proj_1",
});

function AlphaMenuHarness(props: ReturnType<typeof createDefaultProps>) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  return <MobileNavBar {...props} alphaMenuOpen={open} onAlphaMenuOpenChange={setOpen} />;
}

function ControlledMenuHarness(props: ReturnType<typeof createDefaultProps>) {
  const [open, setOpen] = useState(false);
  return <MobileNavBar {...props} alphaMenuOpen={open} onAlphaMenuOpenChange={setOpen} />;
}

function dispatchPopState(navIndex: number) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex } }));
  });
}

async function openMore() {
  fireEvent.click(screen.getByTestId("alpha-mobile-menu-trigger"));
  await waitFor(() => expect(screen.getByTestId("mobile-more-item-activity")).toBeInTheDocument());
}

describe("MobileNavBar More sheet navigation history", () => {
  let navigationHistory: UseNavigationHistoryResult | null;

  beforeEach(() => {
    mockMobileViewport();
    navigationHistory = null;
    window.history.replaceState({ navIndex: 0 }, "");
    vi.mocked(fetchScripts).mockReset();
    vi.mocked(fetchScripts).mockResolvedValue({});
    vi.spyOn(window.history, "back").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithHistory(props = createDefaultProps()) {
    const rendered = render(
      <HistoryHarness onReady={(history) => { navigationHistory = history; }}>
        <ControlledMenuHarness {...props} />
      </HistoryHarness>,
    );
    return { ...rendered, props };
  }

  it("dismisses the Alpha popover on browser Back without rendering drawer chrome or navigating", async () => {
    const props = createDefaultProps();
    const { container } = render(
      <HistoryHarness onReady={(history) => { navigationHistory = history; }}>
        <AlphaMenuHarness {...props} />
      </HistoryHarness>,
    );
    await waitFor(() => expect(screen.getByRole("menu", { name: "Navigate" })).toHaveClass("alpha-mobile-navigation-popover"));
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
    expect(container.querySelector(".mobile-more-sheet-backdrop")).toBeNull();

    dispatchPopState(0);

    await waitFor(() => expect(container.querySelector(".alpha-mobile-navigation-popover")).toBeNull());
    expect(props.onChangeView).not.toHaveBeenCalled();
  });

  it("dismisses the More sheet on browser Back without navigating away", async () => {
    const { container } = renderWithHistory();
    await openMore();

    dispatchPopState(0);

    await waitFor(() => expect(container.querySelector(".mobile-more-sheet")).toBeNull());
    dispatchPopState(0);
    expect(container.querySelector(".mobile-more-sheet")).toBeNull();
  });

  it("routes Android native Back through history before dismissing the official popover", async () => {
    const { container } = renderWithHistory();
    await openMore();
    const nativeBack = new CustomEvent("fusion:native-back", { cancelable: true });

    expect(window.dispatchEvent(nativeBack)).toBe(false);
    expect(window.history.back).toHaveBeenCalledOnce();
    expect(container.querySelector(".alpha-mobile-navigation-popover")).not.toBeNull();

    dispatchPopState(0);
    await waitFor(() => expect(container.querySelector(".alpha-mobile-navigation-popover")).toBeNull());
  });

  async function expectProgrammaticCloseConsumesMoreEntry(close: () => void | Promise<void>) {
    vi.mocked(window.history.back).mockClear();
    const sentinelClose = vi.fn();
    const rendered = renderWithHistory();
    await waitFor(() => expect(navigationHistory).not.toBeNull());
    navigationHistory?.pushNav({ type: "modal", close: sentinelClose });
    await openMore();

    await close();
    expect(screen.queryByTestId("mobile-more-item-activity")).toBeNull();
    expect(window.history.back).toHaveBeenCalledOnce();

    // removeNav's history.back() self-pop is ignored before the lower entry can handle Back.
    dispatchPopState(1);
    expect(sentinelClose).not.toHaveBeenCalled();
    dispatchPopState(0);
    expect(sentinelClose).toHaveBeenCalledOnce();
    rendered.unmount();
  }

  it("replaces the More entry before opening Import so delayed Back cannot consume it", async () => {
    const importClose = vi.fn();
    const props = createDefaultProps();
    props.onOpenGitHubImport = () => {
      navigationHistory?.pushNav({ type: "modal", close: importClose });
    };
    renderWithHistory(props);
    await openMore();

    fireEvent.click(screen.getByTestId("mobile-more-item-github"));

    expect(window.history.back).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mobile-more-item-activity")).toBeNull();

    dispatchPopState(0);
    expect(importClose).toHaveBeenCalledOnce();
  });

  it("consumes the More entry on Escape", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => fireEvent.keyDown(document, { key: "Escape" }));
  });

  it("consumes the More entry when its tab toggles closed", async () => {
    await expectProgrammaticCloseConsumesMoreEntry(() => fireEvent.click(screen.getByTestId("alpha-mobile-menu-trigger")));
  });

  it("consumes the More entry when a script runs", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({ build: "pnpm build" });
    await expectProgrammaticCloseConsumesMoreEntry(async () => {
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
      await waitFor(() => expect(screen.getByTestId("mobile-more-script-item-build")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("mobile-more-script-item-build"));
    });
  });

  it("consumes the More entry from Manage Scripts", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({ build: "pnpm build" });
    await expectProgrammaticCloseConsumesMoreEntry(async () => {
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
      await waitFor(() => expect(screen.getByTestId("mobile-more-scripts-manage")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("mobile-more-scripts-manage"));
    });
  });

  it("consumes the More entry from the no-scripts add-one branch", async () => {
    vi.mocked(fetchScripts).mockResolvedValueOnce({});
    await expectProgrammaticCloseConsumesMoreEntry(async () => {
      fireEvent.click(screen.getByTestId("mobile-more-terminal-split-toggle"));
      await waitFor(() => expect(screen.getByText("No scripts — add one…")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("mobile-more-scripts-manage"));
    });
  });

  it("keeps provider-less official popover renders functional", async () => {
    const { container } = render(<ControlledMenuHarness {...createDefaultProps()} />);
    await openMore();
    fireEvent.click(screen.getByTestId("alpha-mobile-menu-trigger"));
    await waitFor(() => expect(container.querySelector(".alpha-mobile-navigation-popover")).toBeNull());
  });
});
