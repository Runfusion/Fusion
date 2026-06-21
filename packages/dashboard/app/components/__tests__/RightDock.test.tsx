import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RightDock, RIGHT_DOCK_OPEN_STORAGE_KEY, RIGHT_DOCK_VIEW_STORAGE_KEY, RIGHT_DOCK_WIDTH_STORAGE_KEY } from "../RightDock";
import { RightDockExpandModal } from "../RightDockExpandModal";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchWorkspaceFileList: vi.fn().mockResolvedValue({ entries: [], currentPath: "." }),
  };
});

vi.mock("../DocumentsView", () => ({ DocumentsView: () => <div data-testid="mock-documents-view" /> }));
vi.mock("../ResearchView", () => ({ ResearchView: () => <div data-testid="mock-research-view" /> }));
vi.mock("../InsightsView", () => ({ InsightsView: () => <div data-testid="mock-insights-view" /> }));
vi.mock("../EvalsView", () => ({ EvalsView: () => <div data-testid="mock-evals-view" /> }));
vi.mock("../SkillsView", () => ({ SkillsView: () => <div data-testid="mock-skills-view" /> }));
vi.mock("../MemoryView", () => ({ MemoryView: () => <div data-testid="mock-memory-view" /> }));
vi.mock("../SecretsView", () => ({ SecretsView: () => <div data-testid="mock-secrets-view" /> }));
vi.mock("../DevServerView", () => ({ DevServerView: () => <div data-testid="mock-devserver-view" /> }));
vi.mock("../TodoView", () => ({ TodoView: () => <div data-testid="mock-todos-view" /> }));
vi.mock("../GoalsView", () => ({ GoalsView: () => <div data-testid="mock-goals-view" /> }));
vi.mock("../StashRecoveryView", () => ({ StashRecoveryView: () => <div data-testid="mock-stash-recovery-view" /> }));

const renderProps = {
  addToast: vi.fn(),
  projectId: "project-1",
};

describe("RightDock", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders Files by default and restores a persisted selected view", () => {
    const onOpenChange = vi.fn();
    const { unmount } = render(
      <RightDock open={true} onOpenChange={onOpenChange} renderProps={renderProps} />,
    );

    expect(screen.getByTestId("right-dock-tab-files")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("right-dock-files-view")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("right-dock-tab-secrets"));
    expect(window.localStorage.getItem(RIGHT_DOCK_VIEW_STORAGE_KEY)).toBe("secrets");
    unmount();

    render(<RightDock open={true} onOpenChange={onOpenChange} renderProps={renderProps} />);
    expect(screen.getByTestId("right-dock-tab-secrets")).toHaveAttribute("aria-selected", "true");
  });

  it("hides entries gated off by their matching Header flags", () => {
    render(
      <RightDock
        open={true}
        onOpenChange={vi.fn()}
        renderProps={renderProps}
        visibilityOptions={{
          experimentalFeatures: {
            insights: false,
            memoryView: false,
            devServerView: false,
            researchView: false,
            evalsView: false,
            goalsView: false,
          },
          showSkillsTab: false,
          todosEnabled: false,
        }}
      />,
    );

    expect(screen.getByTestId("right-dock-tab-files")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-tab-documents")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-tab-secrets")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-tab-stash-recovery")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-tab-research")).toBeNull();
    expect(screen.queryByTestId("right-dock-tab-insights")).toBeNull();
  });

  it("closes internally and clamps then persists resize width", () => {
    const onOpenChange = vi.fn();
    render(<RightDock open={true} onOpenChange={onOpenChange} renderProps={renderProps} />);

    fireEvent.click(screen.getByTestId("right-dock-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(window.localStorage.getItem(RIGHT_DOCK_OPEN_STORAGE_KEY)).toBe("false");

    const handle = screen.getByTestId("right-dock-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 0 });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("720");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(window.localStorage.getItem(RIGHT_DOCK_WIDTH_STORAGE_KEY)).toBe("672");
  });

  it("restores persisted width on mount", () => {
    window.localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "400");
    render(<RightDock open={true} onOpenChange={vi.fn()} renderProps={renderProps} />);

    expect(screen.getByTestId("right-dock")).toHaveStyle({ width: "400px" });
    expect(screen.getByTestId("right-dock-resize-handle")).toHaveAttribute("aria-valuenow", "400");
  });

  it("mounts every visible static registry view in the dock body without crashing", async () => {
    render(
      <RightDock
        open={true}
        onOpenChange={vi.fn()}
        renderProps={renderProps}
        visibilityOptions={{
          experimentalFeatures: {
            insights: true,
            memoryView: true,
            devServerView: true,
            researchView: true,
            evalsView: true,
            goalsView: true,
          },
          showSkillsTab: true,
          todosEnabled: true,
        }}
      />,
    );

    const expectedViews: Array<[string, string]> = [
      ["right-dock-tab-files", "right-dock-files-view"],
      ["right-dock-tab-documents", "mock-documents-view"],
      ["right-dock-tab-research", "mock-research-view"],
      ["right-dock-tab-insights", "mock-insights-view"],
      ["right-dock-tab-skills", "mock-skills-view"],
      ["right-dock-tab-memory", "mock-memory-view"],
      ["right-dock-tab-secrets", "mock-secrets-view"],
      ["right-dock-tab-stash-recovery", "mock-stash-recovery-view"],
      ["right-dock-tab-evals", "mock-evals-view"],
      ["right-dock-tab-goals", "mock-goals-view"],
      ["right-dock-tab-todos", "mock-todos-view"],
      ["right-dock-tab-devserver", "mock-devserver-view"],
    ];

    for (const [tabId, bodyId] of expectedViews) {
      fireEvent.click(screen.getByTestId(tabId));
      expect(await screen.findByTestId(bodyId)).toBeInTheDocument();
    }
  });

  it("renders the expanded modal through the same registry and restores focus on close", async () => {
    const onClose = vi.fn();
    const focusButton = document.createElement("button");
    document.body.appendChild(focusButton);
    const focusSpy = vi.spyOn(focusButton, "focus");

    render(
      <RightDockExpandModal
        viewKey="secrets"
        renderProps={renderProps}
        onClose={onClose}
        returnFocusRef={{ current: focusButton }}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-expand-body")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(focusSpy).toHaveBeenCalled();
    focusButton.remove();
  });

  it("restores the expanded modal's persisted size", () => {
    window.localStorage.setItem("fusion:right-dock-expand-modal-size", JSON.stringify({ width: 640, height: 480 }));
    render(
      <RightDockExpandModal
        viewKey="secrets"
        renderProps={renderProps}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("right-dock-expand-modal").querySelector(".right-dock-expand-modal")).toHaveStyle({
      width: "640px",
      height: "480px",
    });
  });

  it("fires expand for the selected entry", () => {
    const onExpand = vi.fn();
    render(<RightDock open={true} onOpenChange={vi.fn()} renderProps={renderProps} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("right-dock-tab-secrets"));
    fireEvent.click(screen.getByTestId("right-dock-expand"));
    expect(onExpand).toHaveBeenCalledWith("secrets");
  });
});
