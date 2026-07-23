import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, createEvent } from "@testing-library/react";
import { UsageIndicator } from "../UsageIndicator";
import "../UsageIndicator.css";
import * as useUsageDataModule from "../../hooks/useUsageData";
import type { ProviderUsage } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

// Mock the useUsageData hook
vi.mock("../../hooks/useUsageData", () => ({
  useUsageData: vi.fn(),
}));

const mockUseUsageData = vi.mocked(useUsageDataModule.useUsageData);
type MockUsageDataState = ReturnType<typeof useUsageDataModule.useUsageData>;

function createUsageDataState(overrides: Partial<MockUsageDataState> = {}): MockUsageDataState {
  return {
    providers: [],
    loading: false,
    error: null,
    lastUpdated: null,
    hasFetched: true,
    refresh: vi.fn(),
    ...overrides,
  };
}
const TEST_PROJECT_ID = "proj-123";

function createAnchorRect(partial: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 900,
    y: 50,
    top: 50,
    bottom: 80,
    left: 900,
    right: 940,
    width: 40,
    height: 30,
    toJSON: () => ({}),
    ...partial,
  } as DOMRect;
}
const USAGE_VIEW_MODE_KEY = scopedKey("kb-usage-view-mode", TEST_PROJECT_ID);
const USAGE_HIDDEN_WINDOWS_KEY = scopedKey("kb-usage-hidden-windows", TEST_PROJECT_ID);
const USAGE_PROVIDER_ORDER_KEY = scopedKey("kb-usage-provider-order", TEST_PROJECT_ID);
const USAGE_MODAL_SIZE_KEY = scopedKey("kb-usage-modal-size", TEST_PROJECT_ID);

function setViewportSize({ width, height }: { width: number; height: number }) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    writable: true,
    configurable: true,
    value: height,
  });
  window.dispatchEvent(new Event("resize"));
}

function getWindowIdentity(label: string, index: number): string {
  return `${index}::${label}`;
}

describe("UsageIndicator", () => {
  const mockOnClose = vi.fn();
  const mockRefresh = vi.fn();

  const mockProviders: ProviderUsage[] = [
    {
      name: "Anthropic",
      icon: "🅰️",
      status: "ok",
      plan: "Pro",
      email: "user@example.com",
      windows: [
        {
          label: "Session (5h)",
          percentUsed: 45,
          percentLeft: 55,
          resetText: "resets in 2h 15m",
          resetMs: 8100000,
        },
        {
          label: "Weekly",
          percentUsed: 30,
          percentLeft: 70,
          resetText: "resets in 3d",
          resetMs: 259200000,
        },
      ],
    },
    {
      name: "OpenAI",
      icon: "🤖",
      status: "ok",
      windows: [
        {
          label: "Hourly",
          percentUsed: 75,
          percentLeft: 25,
          resetText: "resets in 45m",
          resetMs: 2700000,
        },
      ],
    },
    {
      name: "Google",
      icon: "🔍",
      status: "no-auth",
      windows: [],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage to ensure clean view mode state
    localStorage.removeItem(USAGE_VIEW_MODE_KEY);
    localStorage.removeItem(USAGE_HIDDEN_WINDOWS_KEY);
    localStorage.removeItem(USAGE_PROVIDER_ORDER_KEY);
    localStorage.removeItem(USAGE_MODAL_SIZE_KEY);
    setViewportSize({ width: 1024, height: 768 });
  });

  it("renders nothing when isOpen is false", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    }));

    const { container } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when isOpen is true", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    expect(screen.getByTestId("usage-modal")).toBeInTheDocument();
    expect(screen.getByText("Usage")).toBeInTheDocument();
    expect(screen.getByTestId("usage-modal")).toHaveClass("usage-modal--popover");
  });

  it("renders provider cards with correct data", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Check provider names are rendered
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();

    // Check status badges
    expect(screen.getByText("Not configured")).toBeInTheDocument();

    // Check usage windows
    expect(screen.getByText("Session (5h)")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("Hourly")).toBeInTheDocument();
  });

  it("renders drag handle in the right-side actions cluster for each provider card", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const cards = Array.from(document.querySelectorAll(".usage-provider"));
    expect(cards).toHaveLength(3);

    cards.forEach((card) => {
      const info = card.querySelector(".usage-provider-info");
      const actions = card.querySelector(".usage-provider-actions");
      const handle = card.querySelector(".usage-provider-drag-handle");
      const headerChildren = Array.from(card.querySelectorAll(":scope > .usage-provider-header > *"));

      expect(info).toBeInTheDocument();
      expect(actions).toBeInTheDocument();
      expect(handle).toBeInTheDocument();
      expect(actions).toContainElement(handle);
      expect(info?.contains(handle)).toBe(false);
      expect(headerChildren[0]).toBe(info);
    });
  });

  it("reorders providers on drag and drop and persists order", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const cardsBefore = Array.from(document.querySelectorAll(".usage-provider"));
    expect(cardsBefore.map((card) => card.getAttribute("data-provider"))).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
    ]);

    const draggedCard = cardsBefore[0] as HTMLElement;
    const targetCard = cardsBefore[1] as HTMLElement;
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "Anthropic"),
      effectAllowed: "",
      dropEffect: "",
    };

    Object.defineProperty(targetCard, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) }),
      configurable: true,
    });

    fireEvent.dragStart(draggedCard, { dataTransfer });
    fireEvent.dragOver(targetCard, { dataTransfer, clientY: 80 });
    fireEvent.drop(targetCard, { dataTransfer });
    fireEvent.dragEnd(draggedCard, { dataTransfer });

    const cardsAfter = Array.from(document.querySelectorAll(".usage-provider"));
    expect(cardsAfter.map((card) => card.getAttribute("data-provider"))).toEqual([
      "OpenAI",
      "Anthropic",
      "Google",
    ]);
    expect(localStorage.getItem(USAGE_PROVIDER_ORDER_KEY)).toBe(
      JSON.stringify(["OpenAI", "Anthropic", "Google"])
    );
  });

  it("loads persisted provider order on remount and appends new providers", () => {
    localStorage.setItem(USAGE_PROVIDER_ORDER_KEY, JSON.stringify(["OpenAI", "Anthropic"]));

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const cards = Array.from(document.querySelectorAll(".usage-provider"));
    expect(cards.map((card) => card.getAttribute("data-provider"))).toEqual([
      "OpenAI",
      "Anthropic",
      "Google",
    ]);
  });

  it("applies drag visual feedback classes", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const cards = Array.from(document.querySelectorAll(".usage-provider"));
    const draggedCard = cards[0] as HTMLElement;
    const targetCard = cards[1] as HTMLElement;
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "Anthropic"),
      effectAllowed: "",
      dropEffect: "",
    };

    Object.defineProperty(targetCard, "getBoundingClientRect", {
      value: () => ({ top: 100, height: 100, bottom: 200, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }),
      configurable: true,
    });

    fireEvent.dragStart(draggedCard, { dataTransfer });
    expect(draggedCard).toHaveClass("usage-provider--dragging");

    const dragOverBefore = createEvent.dragOver(targetCard, { dataTransfer });
    Object.defineProperty(dragOverBefore, "clientY", { value: 120 });
    fireEvent(targetCard, dragOverBefore);
    expect(targetCard).toHaveClass("usage-provider--drag-over-before");

    const dragOverAfter = createEvent.dragOver(targetCard, { dataTransfer });
    Object.defineProperty(dragOverAfter, "clientY", { value: 190 });
    fireEvent(targetCard, dragOverAfter);
    expect(targetCard).toHaveClass("usage-provider--drag-over-after");

    fireEvent.dragEnd(draggedCard, { dataTransfer });
    expect(draggedCard).not.toHaveClass("usage-provider--dragging");
  });

  it("reorders providers with move buttons in touch mode", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Move OpenAI up" }));

    const cardsAfter = Array.from(document.querySelectorAll(".usage-provider"));
    expect(cardsAfter.map((card) => card.getAttribute("data-provider"))).toEqual([
      "OpenAI",
      "Anthropic",
      "Google",
    ]);

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("shows loading skeleton when loading", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: true,
      error: null,
      lastUpdated: null,
      hasFetched: false,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton elements
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows error state when there is an error", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: "Failed to fetch usage data",
      lastUpdated: null,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("Failed to load usage data")).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch usage data")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows empty state after an empty fetch completes", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("No AI providers configured")).toBeInTheDocument();
    expect(document.querySelector(".usage-skeleton")).not.toBeInTheDocument();
  });

  it("calls refresh when refresh button clicked", async () => {
    mockRefresh.mockResolvedValue(undefined);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const refreshBtn = screen.getByTestId("usage-refresh-btn");
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button clicked", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const closeBtn = screen.getByTestId("usage-modal-close");
    fireEvent.click(closeBtn);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("renders as top-biased popover below a high desktop anchor", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(modal).toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("88px");
    expect(Number.parseFloat(modal.style.top)).toBeLessThan(window.innerHeight / 2);
    expect(modal.style.left).toBe("520px");
  });

  it("keeps the desktop popover near the top on a short viewport", () => {
    setViewportSize({ width: 1024, height: 240 });
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(modal).toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("88px");
    expect(Number.parseFloat(modal.style.top)).toBeLessThan(window.innerHeight / 2);
  });

  it("clamps the desktop popover near the top for a low anchor while preserving saved size", () => {
    setViewportSize({ width: 1024, height: 800 });
    localStorage.setItem(USAGE_MODAL_SIZE_KEY, JSON.stringify({ width: 600, height: 500 }));
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect({ top: 620, bottom: 650 })}
      />
    );

    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(modal).toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("96px");
    expect(Number.parseFloat(modal.style.top)).toBeLessThan(window.innerHeight / 4);
    expect(modal.style.left).toBe("340px");
    expect(modal.style.width).toBe("600px");
    expect(modal.style.height).toBe("500px");
  });

  it("keeps the desktop popover near the board top on a tall viewport with a low anchor", () => {
    setViewportSize({ width: 1280, height: 1440 });
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect({ top: 620, bottom: 650 })}
      />
    );

    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    const top = Number.parseFloat(modal.style.top);
    expect(modal).toHaveClass("usage-modal--popover");
    expect(top).toBeLessThanOrEqual(96);
    expect(top).toBeLessThan(window.innerHeight / 4);
  });

  it("renders as top-aligned full-screen modal when anchorRect is null", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} anchorRect={null} />);

    const overlay = screen.getByTestId("usage-modal-overlay");
    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(overlay).toHaveClass("modal-overlay", "open", "usage-modal-overlay");
    expect(modal).toHaveClass("modal");
    expect(modal).not.toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("");
    expect(modal.parentElement).toBe(overlay);
  });

  it("uses the top-aligned mobile sheet surface instead of the desktop popover", () => {
    setViewportSize({ width: 768, height: 600 });
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    const overlay = screen.getByTestId("usage-modal-overlay");
    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(overlay).toHaveClass("usage-modal-overlay");
    expect(modal).toHaveClass("usage-modal", "modal");
    expect(modal).not.toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("");
  });

  it.each([
    ["populated", createUsageDataState({ providers: mockProviders, loading: false, error: null, lastUpdated: new Date(), refresh: mockRefresh }), "Anthropic"],
    ["empty", createUsageDataState({ providers: [], loading: false, error: null, lastUpdated: null, refresh: mockRefresh }), "No AI providers configured"],
    ["loading", createUsageDataState({ providers: [], loading: true, error: null, lastUpdated: null, hasFetched: false, refresh: mockRefresh }), null],
    ["error", createUsageDataState({ providers: [], loading: false, error: "Failed to fetch usage data", lastUpdated: null, refresh: mockRefresh }), "Failed to load usage data"],
  ])("keeps top-biased popover positioning for %s content", (_stateName, usageState, expectedText) => {
    setViewportSize({ width: 1024, height: 240 });
    mockUseUsageData.mockReturnValue(usageState);

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect({ top: 180, bottom: 210 })}
      />
    );

    const modal = screen.getByTestId("usage-modal") as HTMLElement;
    expect(modal).toHaveClass("usage-modal--popover");
    expect(modal.style.top).toBe("96px");
    expect(Number.parseFloat(modal.style.top)).toBeLessThan(window.innerHeight / 2);
    if (expectedText) {
      expect(screen.getByText(expectedText)).toBeInTheDocument();
    } else {
      expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
    }
  });

  it("calls onClose when overlay is clicked", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const overlay = screen.getByTestId("usage-modal-overlay");
    fireEvent.click(overlay);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when desktop popover backdrop is clicked", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    fireEvent.click(screen.getByTestId("usage-modal-overlay"));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("renders progress bars with correct color classes", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Low Usage", percentUsed: 45, percentLeft: 55, resetText: "1h" },
            { label: "Medium Usage", percentUsed: 75, percentLeft: 25, resetText: "2h" },
            { label: "High Usage", percentUsed: 95, percentLeft: 5, resetText: "3h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Check progress bars exist with correct widths
    const progressBars = document.querySelectorAll(".usage-progress-fill");
    expect(progressBars.length).toBe(3);

    // Check color classes are applied
    expect(document.querySelector(".usage-progress-fill--low")).toBeInTheDocument();
    expect(document.querySelector(".usage-progress-fill--medium")).toBeInTheDocument();
    expect(document.querySelector(".usage-progress-fill--high")).toBeInTheDocument();
  });

  it("disables refresh button when loading", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: true,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const refreshBtn = screen.getByTestId("usage-refresh-btn");
    expect(refreshBtn).toBeDisabled();
  });

  it("passes autoRefresh option based on isOpen prop", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    }));

    // Reset mock before testing
    mockUseUsageData.mockClear();

    // When isOpen is true, autoRefresh should be true
    const { unmount } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(mockUseUsageData).toHaveBeenCalledWith({ autoRefresh: true });

    unmount();

    // Reset mock
    mockUseUsageData.mockClear();

    // When isOpen is false, autoRefresh should be false to prevent polling
    render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // The hook is called even when isOpen is false because hooks must be called
    // unconditionally at the top level in React
    expect(mockUseUsageData).toHaveBeenCalledWith({ autoRefresh: false });
  });

  it("does not render a Connected badge for providers with ok status", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Anthropic",
          icon: "🅰️",
          status: "ok",
          windows: [],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("renders provider error messages", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "ErrorProvider",
          icon: "❌",
          status: "error",
          error: "Auth expired — run 'claude' to re-login",
          windows: [],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Auth expired — run 'claude' to re-login")).toBeInTheDocument();
  });

  it("shows last updated timestamp", () => {
    const lastUpdated = new Date("2024-01-15T10:30:00");
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
    expect(screen.getByText(/10:30:00/)).toBeInTheDocument();
  });

  it("keeps footer metadata on the left and action buttons on the right", () => {
    const lastUpdated = new Date("2024-01-15T10:30:00");
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const footer = document.querySelector(".usage-actions");
    const leftGroup = document.querySelector(".usage-actions-left");
    const rightGroup = document.querySelector(".usage-actions-right");

    expect(footer).toBeInTheDocument();
    expect(leftGroup).toBeInTheDocument();
    expect(rightGroup).toBeInTheDocument();

    const lastUpdatedLabel = screen.getByText(/Last updated:/);
    const refreshButton = screen.getByTestId("usage-refresh-btn");
    const closeButton = screen.getByRole("button", { name: "Close" });

    expect(leftGroup).toContainElement(lastUpdatedLabel);
    expect(rightGroup).toContainElement(refreshButton);
    expect(rightGroup).toContainElement(closeButton);

    expect(footer?.firstElementChild).toBe(leftGroup);
    expect(footer?.lastElementChild).toBe(rightGroup);
  });

  it("renders usage windows with correct percentage text", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 45, percentLeft: 55, resetText: "resets in 2h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("45% used")).toBeInTheDocument();
    expect(screen.getByText("55% left")).toBeInTheDocument();
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
  });

  // View mode toggle tests
  it("renders view mode toggle buttons with correct initial state", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const usedBtn = screen.getByTestId("usage-view-toggle-used");
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    expect(usedBtn).toBeInTheDocument();
    expect(remainingBtn).toBeInTheDocument();
    expect(usedBtn).toHaveClass("active");
    expect(remainingBtn).not.toHaveClass("active");
  });

  it("switches view mode when toggle buttons are clicked", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 45, percentLeft: 55, resetText: "resets in 2h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const usedBtn = screen.getByTestId("usage-view-toggle-used");
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    // Initially shows "used" view
    expect(screen.getByText("45% used")).toBeInTheDocument();

    // Click remaining button
    fireEvent.click(remainingBtn);

    // Now should show "remaining" view
    expect(remainingBtn).toHaveClass("active");
    expect(usedBtn).not.toHaveClass("active");
    expect(screen.getByText("55% remaining")).toBeInTheDocument();
    expect(screen.getByText("45% used")).toBeInTheDocument(); // Footer text

    // Click back to used
    fireEvent.click(usedBtn);

    expect(usedBtn).toHaveClass("active");
    expect(remainingBtn).not.toHaveClass("active");
    expect(screen.getByText("45% used")).toBeInTheDocument();
  });

  it("reads view mode from localStorage on mount", () => {
    // Set localStorage to 'remaining' before rendering
    localStorage.setItem(USAGE_VIEW_MODE_KEY, "remaining");

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 45, percentLeft: 55, resetText: "resets in 2h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const usedBtn = screen.getByTestId("usage-view-toggle-used");
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    // Should initialize to 'remaining' from localStorage
    expect(remainingBtn).toHaveClass("active");
    expect(usedBtn).not.toHaveClass("active");
    expect(screen.getByText("55% remaining")).toBeInTheDocument();

    // Clean up
    localStorage.removeItem(USAGE_VIEW_MODE_KEY);
  });

  it("persists view mode to localStorage when changed", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    // Click remaining button
    fireEvent.click(remainingBtn);

    // Should save to localStorage
    expect(localStorage.getItem(USAGE_VIEW_MODE_KEY)).toBe("remaining");

    // Clean up
    localStorage.removeItem(USAGE_VIEW_MODE_KEY);
  });

  it("renders eye icon button on each usage window row", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getAllByTestId("usage-window-hide-btn")).toHaveLength(3);
  });

  it("clicking eye icon hides a window row", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const sessionLabel = screen.getByText("Session (5h)");
    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    const hiddenRow = sessionLabel.closest(".usage-window");
    expect(hiddenRow).toHaveClass("usage-window--hidden");
    expect(sessionLabel).not.toBeVisible();
    expect(screen.queryByText("45% used")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide Session (5h)" })).not.toBeInTheDocument();
  });

  it("hidden window does not occupy layout space", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const sessionRow = screen.getByText("Session (5h)").closest(".usage-window") as HTMLElement;
    expect(sessionRow).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    expect(sessionRow).not.toBeVisible();
    expect(getComputedStyle(sessionRow).display).toBe("none");
  });

  it("persists hidden windows to localStorage", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(
      JSON.stringify({ Anthropic: [getWindowIdentity("Session (5h)", 0)] })
    );
  });

  it("restores hidden windows from legacy label-only localStorage on mount", () => {
    localStorage.setItem(
      USAGE_HIDDEN_WINDOWS_KEY,
      JSON.stringify({ Anthropic: ["Session (5h)"] })
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const hiddenRow = screen.getByText("Session (5h)").closest(".usage-window");
    expect(hiddenRow).toHaveClass("usage-window--hidden");
  });

  it("shows provider-level show hidden button when windows are hidden", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (1)");
  });

  it("shows restorable hidden count for orphaned persisted labels on mobile/modal surfaces", () => {
    localStorage.setItem(
      USAGE_HIDDEN_WINDOWS_KEY,
      JSON.stringify({ minimax: ["WindowGone"] })
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "minimax",
          icon: "🧠",
          status: "ok",
          windows: [
            {
              label: "Live Window",
              percentUsed: 25,
              percentLeft: 75,
              resetText: "resets in 2h",
              resetMs: 7200000,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={null}
      />
    );

    const showHiddenButton = screen.getByTestId("usage-show-hidden-btn");
    expect(showHiddenButton).toHaveTextContent("Show hidden (1)");
    expect(document.querySelectorAll(".usage-window--hidden")).toHaveLength(0);

    fireEvent.click(showHiddenButton);

    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(JSON.stringify({}));
    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
  });

  it("adds orphaned persisted labels to rendered hidden counts on desktop popover surfaces", () => {
    localStorage.setItem(
      USAGE_HIDDEN_WINDOWS_KEY,
      JSON.stringify({ Anthropic: ["Session (5h)", "WindowGone"] })
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    expect(document.querySelectorAll(".usage-window--hidden")).toHaveLength(1);
    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (2)");
  });

  it("hiding one duplicate-labeled MiniMax window only hides that instance", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "MiniMax",
          icon: "🧠",
          status: "ok",
          windows: [
            {
              label: "Daily",
              percentUsed: 20,
              percentLeft: 80,
              resetText: "resets in 1h",
              resetMs: 3600000,
            },
            {
              label: "Daily",
              percentUsed: 60,
              percentLeft: 40,
              resetText: "resets in 4h",
              resetMs: 14400000,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Hide Daily" })[1]);

    const hiddenRows = Array.from(document.querySelectorAll(".usage-window--hidden"));
    expect(hiddenRows).toHaveLength(1);
    expect(hiddenRows[0]).toHaveTextContent("Daily");
    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(
      JSON.stringify({ MiniMax: [getWindowIdentity("Daily", 1)] })
    );
    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (1)");

    fireEvent.click(screen.getByTestId("usage-show-hidden-btn"));

    expect(document.querySelectorAll(".usage-window--hidden")).toHaveLength(0);
    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
  });

  it("counts currently rendered hidden rows when legacy persisted labels match duplicate live windows", () => {
    localStorage.setItem(
      USAGE_HIDDEN_WINDOWS_KEY,
      JSON.stringify({ Anthropic: ["Daily"] })
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Anthropic",
          icon: "🅰️",
          status: "ok",
          windows: [
            {
              label: "Daily",
              percentUsed: 20,
              percentLeft: 80,
              resetText: "resets in 1h",
              resetMs: 3600000,
            },
            {
              label: "Daily",
              percentUsed: 60,
              percentLeft: 40,
              resetText: "resets in 4h",
              resetMs: 14400000,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelectorAll(".usage-window--hidden")).toHaveLength(2);
    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (2)");
  });

  it("renders show hidden button inline within provider info", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    const showHiddenButton = screen.getByTestId("usage-show-hidden-btn");
    expect(showHiddenButton.closest(".usage-provider-info")).toBeTruthy();
    expect(showHiddenButton.closest(".usage-provider-actions")).toBeNull();
  });

  it("show hidden button reveals all hidden windows for a provider", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Weekly" }));

    fireEvent.click(screen.getByTestId("usage-show-hidden-btn"));

    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
    expect(screen.getByText("Session (5h)").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
    expect(screen.getByText("Weekly").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
    expect(screen.getByRole("button", { name: "Hide Session (5h)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Weekly" })).toBeInTheDocument();
  });

  it("show hidden remains revealed across rerender and does not submit parent forms", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    const onSubmit = vi.fn((event: Event) => {
      event.preventDefault();
    });

    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));
    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(
      JSON.stringify({ Anthropic: [getWindowIdentity("Session (5h)", 0)] })
    );

    fireEvent.click(screen.getByTestId("usage-show-hidden-btn"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(JSON.stringify({}));
    expect(screen.getByText("Session (5h)").closest(".usage-window")).not.toHaveClass("usage-window--hidden");

    rerender(
      <form onSubmit={onSubmit}>
        <UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />
      </form>
    );

    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
    expect(screen.getByText("Session (5h)").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
  });

  it("tracks multiple distinct hidden Anthropic windows per instance", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Weekly" }));

    expect(document.querySelectorAll(".usage-window--hidden")).toHaveLength(2);
    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (2)");
    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(
      JSON.stringify({
        Anthropic: [
          getWindowIdentity("Session (5h)", 0),
          getWindowIdentity("Weekly", 1),
        ],
      })
    );
  });

  it("does not show provider-level show hidden button when no windows are hidden", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
  });

  it("does not crash or show hidden controls when provider windows are empty or undefined", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Anthropic", icon: "🅰️", status: "ok", windows: [] },
        { name: "MiniMax", icon: "🧠", status: "ok", windows: undefined as unknown as ProviderUsage["windows"] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(
      <UsageIndicator
        isOpen={true}
        onClose={mockOnClose}
        projectId={TEST_PROJECT_ID}
        anchorRect={createAnchorRect()}
      />
    );

    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("MiniMax")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
  });


  // ProviderIcon integration tests
  it("renders SVG provider icons instead of emoji", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Anthropic", icon: "🅰️", status: "ok", windows: [] },
        { name: "OpenAI", icon: "🤖", status: "ok", windows: [] },
        { name: "Google", icon: "🔍", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should render SVG icons with correct provider data attributes
    expect(document.querySelector('[data-provider="anthropic"]')).toBeInTheDocument();
    expect(document.querySelector('[data-provider="openai"]')).toBeInTheDocument();
    expect(document.querySelector('[data-provider="google"]')).toBeInTheDocument();
  });

  it("maps Claude provider to anthropic icon", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Claude", icon: "🅰️", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="anthropic"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='Anthropic']")).toBeInTheDocument();
  });

  it("maps Codex provider to openai icon", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Codex", icon: "🤖", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="openai"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='OpenAI']")).toBeInTheDocument();
  });

  it("maps Gemini provider to google icon", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Gemini", icon: "🔍", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="google"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='Google Gemini']")).toBeInTheDocument();
  });

  it("maps Kimi provider to kimi icon", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Kimi", icon: "🌙", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="kimi"]')).toBeInTheDocument();
  });

  it("maps Moonshot provider to kimi icon (alias)", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "Moonshot", icon: "🌙", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="kimi"]')).toBeInTheDocument();
    expect(screen.getByText("Moonshot")).toBeInTheDocument();
  });

  it("maps Xiaomi MiMo usage labels through the shared provider inference", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        { name: "xiaomi/MiMo-V2-Flash", icon: "🟠", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByTestId("xiaomi-icon")).toBeInTheDocument();
    expect(document.querySelector('[data-provider="xiaomi"]')).toBeInTheDocument();
  });

  it("maps Cursor provider to the cursor-cli icon and renders usage windows", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Cursor",
          icon: "🟣",
          status: "ok",
          windows: [
            { label: "Monthly spend", percentUsed: 25, percentLeft: 75, resetText: "resets in 15d" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByTestId("cursor-cli-icon")).toBeInTheDocument();
    expect(document.querySelector('[data-provider="cursor-cli"]')).toBeInTheDocument();
    expect(screen.getByText("Monthly spend")).toBeInTheDocument();
    expect(screen.getByText("25% used")).toBeInTheDocument();
  });

  // Pace indicator tests
  it("renders pace marker for weekly windows with timing data", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 30, 
              percentLeft: 70, 
              resetText: "resets in 3d",
              resetMs: 259200000, // 3 days remaining
              windowDurationMs: 604800000, // 7 days total
              pace: {
                status: "behind",
                percentElapsed: 57,
                message: "27% under pace",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarker = document.querySelector('[data-testid="pace-marker"]');
    expect(paceMarker).toBeInTheDocument();
  });

  it("does not render pace marker for non-weekly windows (Session, Hourly)", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Session (5h)", 
              percentUsed: 45, 
              percentLeft: 55, 
              resetText: "resets in 2h",
              resetMs: 7200000,
              windowDurationMs: 18000000,
            },
            { 
              label: "Hourly", 
              percentUsed: 60, 
              percentLeft: 40, 
              resetText: "resets in 30m",
              resetMs: 1800000,
              windowDurationMs: 3600000,
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarkers = document.querySelectorAll('[data-testid="pace-marker"]');
    expect(paceMarkers.length).toBe(0);
  });

  it("does not render pace marker when pace is undefined", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 30, 
              percentLeft: 70, 
              resetText: "resets in 3d",
              // No pace field
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarker = document.querySelector('[data-testid="pace-marker"]');
    expect(paceMarker).not.toBeInTheDocument();
  });

  it("shows 'ahead of pace' text when usage exceeds elapsed time by >5%", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 70, // 70% used
              percentLeft: 30, 
              resetText: "resets in 3.5d",
              resetMs: 302400000, // 3.5 days remaining out of 7
              windowDurationMs: 604800000, // 7 days total
              pace: {
                status: "ahead",
                percentElapsed: 50,
                message: "20% over pace",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/over pace/);
    expect(paceRow).toHaveTextContent("20%");
  });

  it("shows 'behind pace' text when usage is under elapsed time by >5%", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 20, // 20% used
              percentLeft: 80, 
              resetText: "resets in 3.5d",
              resetMs: 302400000, // 3.5 days remaining out of 7
              windowDurationMs: 604800000, // 7 days total
              pace: {
                status: "behind",
                percentElapsed: 50,
                message: "30% under pace",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/under pace/);
    expect(paceRow).toHaveTextContent("30%");
  });

  it("shows 'on pace' text when usage is within 5% of elapsed time", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 52, // 52% used
              percentLeft: 48, 
              resetText: "resets in 3.5d",
              resetMs: 302400000, // 3.5 days remaining out of 7
              windowDurationMs: 604800000, // 7 days total
              pace: {
                status: "on-track",
                percentElapsed: 50,
                message: "On pace with time elapsed",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/On pace/);
  });

  it("pace marker position inverts correctly when switching to remaining mode", () => {
    // Mock provider with weekly window
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 30, 
              percentLeft: 70, 
              resetText: "resets in 3.5d",
              resetMs: 302400000, // 50% elapsed
              windowDurationMs: 604800000,
              pace: {
                status: "behind",
                percentElapsed: 50,
                message: "20% under pace",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // In used mode: marker at 50%
    let paceMarker = document.querySelector('[data-testid="pace-marker"]') as HTMLElement;
    expect(paceMarker).toBeInTheDocument();
    expect(paceMarker.style.left).toBe("50%");

    // Switch to remaining mode
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");
    fireEvent.click(remainingBtn);

    // In remaining mode: marker at 100 - 50 = 50% (same in this case since it's 50/50)
    paceMarker = document.querySelector('[data-testid="pace-marker"]') as HTMLElement;
    expect(paceMarker.style.left).toBe("50%");
  });

  it("pace percentage text uses backend message directly", () => {
    // Clear localStorage to ensure fresh 'used' mode
    localStorage.removeItem(USAGE_VIEW_MODE_KEY);
    
    // Setup: 70% used (ahead of pace), 30% remaining
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { 
              label: "Weekly", 
              percentUsed: 70, // 70% used
              percentLeft: 30, 
              resetText: "resets in 3.5d",
              resetMs: 302400000, // 50% elapsed
              windowDurationMs: 604800000,
              pace: {
                status: "ahead",
                percentElapsed: 50,
                message: "20% over pace",
              },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // In used mode: ahead of pace (70% used vs 50% elapsed)
    let paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/over pace/);

    // Switch to remaining mode - message stays the same (from backend)
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");
    fireEvent.click(remainingBtn);

    // The message comes from backend, so it doesn't change based on view mode
    paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent("20% over pace");
  });

  // Refresh-on-open behavior tests
  it("calls refresh when isOpen transitions from false to true", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: null, // No recent update, should refresh
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Initially isOpen is false, refresh should not be called
    expect(mockRefresh).not.toHaveBeenCalled();

    // Open the modal - isOpen transitions to true
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should be called when modal opens
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not call refresh when isOpen is already true on mount", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    // Render with isOpen=true initially
    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should NOT be called on initial mount when isOpen is already true
    // (the hook will handle initial data fetch)
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("does not call refresh when isOpen becomes false (modal closes)", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Clear any calls from initial render
    mockRefresh.mockClear();

    // Close the modal - isOpen transitions to false
    rerender(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should NOT be called when modal closes
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("skips refresh if data was updated within last 5 seconds", () => {
    // Data was just updated (within 5 seconds)
    const recentUpdate = new Date(Date.now() - 2000); // 2 seconds ago

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: recentUpdate,
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Clear any calls from initial render
    mockRefresh.mockClear();

    // Open the modal
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should NOT be called because data is fresh (within 5 seconds)
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("calls refresh when modal opens if data is stale (older than 5 seconds)", () => {
    // Data was updated 10 seconds ago (stale)
    const staleUpdate = new Date(Date.now() - 10000); // 10 seconds ago

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: staleUpdate,
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Clear any calls from initial render
    mockRefresh.mockClear();

    // Open the modal
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should be called because data is stale (older than 5 seconds)
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls refresh again when modal reopens after being closed", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Open the modal first time
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    // Close the modal
    rerender(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Reopen the modal
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should be called again on reopen
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // Initial loading state tests
  it("shows skeleton when modal opens with no cached data", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      hasFetched: false,
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton because initial fetch hasn't completed
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows skeleton when modal reopens after being closed with data", () => {
    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // First open: show data
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show providers, not skeleton
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(document.querySelector(".usage-skeleton")).not.toBeInTheDocument();

    // Close the modal
    rerender(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      hasFetched: false,
      refresh: mockRefresh,
    }));

    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton on reopen until providers arrive
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows providers once data arrives after initial skeleton", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      hasFetched: false,
      refresh: mockRefresh,
    }));

    const { rerender } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton initially
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();

    // Simulate data arriving
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    // Trigger a re-render with new data
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Now should show providers
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(document.querySelector(".usage-skeleton")).not.toBeInTheDocument();
  });

  // Percentage rounding tests
  it("rounds percentage values in display text (whole numbers)", () => {
    // Use decimal percentages to verify rounding
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 45.678, percentLeft: 54.322, resetText: "resets in 2h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should display rounded values: 46% used, 54% left
    expect(screen.getByText("46% used")).toBeInTheDocument();
    expect(screen.getByText("54% left")).toBeInTheDocument();
  });

  it("rounds percentage values in remaining view mode", () => {
    // Use decimal percentages to verify rounding
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 33.333, percentLeft: 66.667, resetText: "resets in 3h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Switch to remaining mode
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");
    fireEvent.click(remainingBtn);

    // Should display rounded values: 67% remaining, 33% used
    expect(screen.getByText("67% remaining")).toBeInTheDocument();
    expect(screen.getByText("33% used")).toBeInTheDocument();
  });

  it("rounds percentage values in progress bar width", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "TestProvider",
          icon: "🧪",
          status: "ok",
          windows: [
            { label: "Session", percentUsed: 45.678, percentLeft: 54.322, resetText: "resets in 2h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Check progress bar width is rounded
    const progressBar = document.querySelector(".usage-progress-fill") as HTMLElement;
    expect(progressBar).toBeInTheDocument();
    expect(progressBar.style.width).toBe("46%"); // 45.678 rounds to 46
  });

  // resetAt timestamp display tests
  it("shows absolute reset time when resetAt is provided", () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 45,
              percentLeft: 55,
              resetText: "resets in 2h",
              resetMs: 7200000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show both relative text and absolute time
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  it("does not show absolute reset time when resetAt is absent", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 45,
              percentLeft: 55,
              resetText: "resets in 2h",
              resetMs: 7200000,
              // no resetAt
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
    expect(document.querySelector(".usage-window-reset-at")).not.toBeInTheDocument();
  });

  it("Claude weekly window shows absolute reset time when resetAt is provided", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 30,
              percentLeft: 70,
              resetText: "resets in 3d",
              resetMs: 259200000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Relative reset text should be present
    expect(screen.getByText("resets in 3d")).toBeInTheDocument();
    // All windows now show the absolute timestamp when resetAt is available
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  it("Claude 5h session row shows both relative reset text and absolute reset time", () => {
    // Simulate a realistic Claude usage payload with Session (5h) + Weekly windows
    const sessionResetAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h from now
    const weeklyResetAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5d from now
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          plan: "Pro",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 45,
              percentLeft: 55,
              resetText: "resets in 2h",
              resetMs: 7200000,
              resetAt: sessionResetAt.toISOString(),
            },
            {
              label: "Weekly",
              percentUsed: 30,
              percentLeft: 70,
              resetText: "resets in 5d",
              resetMs: 432000000,
              resetAt: weeklyResetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Session (5h) row should exist
    expect(screen.getByText("Session (5h)")).toBeInTheDocument();

    // Both relative reset texts should be present
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
    expect(screen.getByText("resets in 5d")).toBeInTheDocument();

    // Both rows show the absolute reset time (no more suppression for Claude weekly)
    const resetAtElements = document.querySelectorAll(".usage-window-reset-at");
    expect(resetAtElements.length).toBe(2);

    // Session row should show the absolute time formatted for today (just time like "2:30 PM")
    const sessionResetAtEl = resetAtElements[0];
    expect(sessionResetAtEl.textContent).toBeTruthy();
    // It should be a time-only format (e.g., "12:30 PM") since the reset is today
    expect(sessionResetAtEl.textContent).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);

    // Verify provider card shows plan
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });

  it("Claude 5h session row without resetAt only shows relative reset text", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 60,
              percentLeft: 40,
              resetText: "resets in 1h 30m",
              resetMs: 5400000,
              // No resetAt — backend couldn't infer the exact timestamp
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Session (5h) should still be visible
    expect(screen.getByText("Session (5h)")).toBeInTheDocument();

    // Relative reset text should be present
    expect(screen.getByText("resets in 1h 30m")).toBeInTheDocument();

    // No absolute reset time element
    expect(document.querySelector(".usage-window-reset-at")).not.toBeInTheDocument();
  });

  it("non-Claude providers are unaffected by resetAt display feature", () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 20,
              percentLeft: 80,
              resetText: "resets in 4h",
              resetMs: 14400000,
              // Codex also supports resetAt from its API
              resetAt: resetAt.toISOString(),
            },
          ],
        },
        {
          name: "Gemini",
          icon: "🔵",
          status: "ok",
          windows: [
            {
              label: "Flash models",
              percentUsed: 10,
              percentLeft: 90,
              resetText: "resets in 6h",
              resetMs: 21600000,
              // No resetAt for Gemini
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Both providers should render normally
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("Flash models")).toBeInTheDocument();

    // Codex should show absolute reset time (since it provides resetAt)
    expect(document.querySelectorAll(".usage-window-reset-at").length).toBe(1);

    // Both providers should show their relative reset text
    expect(screen.getByText("resets in 4h")).toBeInTheDocument();
    expect(screen.getByText("resets in 6h")).toBeInTheDocument();
  });

  it("Claude weekly variant labels show absolute reset time when resetAt is provided", () => {
    const resetAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly (Sonnet)",
              percentUsed: 40,
              percentLeft: 60,
              resetText: "resets in 4d",
              resetMs: 345600000,
              resetAt: resetAt.toISOString(),
            },
            {
              label: "Weekly (Opus)",
              percentUsed: 25,
              percentLeft: 75,
              resetText: "resets in 4d",
              resetMs: 345600000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Relative reset text should be present for both weekly variants
    const resetTexts = screen.getAllByText("resets in 4d");
    expect(resetTexts.length).toBe(2);

    // Both weekly variants now show absolute timestamp
    expect(document.querySelectorAll(".usage-window-reset-at").length).toBe(2);
  });

  it("Anthropic provider name shows absolute reset time for weekly windows", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Anthropic",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 35,
              percentLeft: 65,
              resetText: "resets in 3d",
              resetMs: 259200000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 3d")).toBeInTheDocument();
    // All providers now show the absolute reset time for all windows
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  it("non-Claude weekly windows still show absolute reset time when provided", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 20,
              percentLeft: 80,
              resetText: "resets in 3d",
              resetMs: 259200000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 3d")).toBeInTheDocument();
    // Non-Claude weekly windows are unaffected — should still show absolute time
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  // Claude weekly reset fallback tests
  it("Claude weekly window generates fallback relative text when resetText is null but resetAt exists", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000); // 3d 5h
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 30,
              percentLeft: 70,
              resetText: null, // No resetText from backend
              resetMs: 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show fallback "resets in Xd Xh" text
    expect(screen.getByText(/resets in \d+d \d+h/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows only days when no remainder hours", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // exactly 3d
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 30,
              percentLeft: 70,
              resetText: null,
              resetMs: 3 * 24 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+d/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows hours when less than 1 day remaining", () => {
    const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000); // 5h
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 80,
              percentLeft: 20,
              resetText: null,
              resetMs: 5 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+h/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows minutes when less than 1 hour remaining", () => {
    const resetAt = new Date(Date.now() + 45 * 60 * 1000); // 45m
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 95,
              percentLeft: 5,
              resetText: null,
              resetMs: 45 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+m/)).toBeInTheDocument();
  });

  it("Claude weekly window does not show fallback when both resetText and resetAt are null", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 50,
              percentLeft: 50,
              resetText: null,
              // No resetAt either
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // No reset text should be shown
    expect(document.querySelector(".usage-window-reset")).not.toBeInTheDocument();
  });

  it("Claude session window generates fallback reset text from resetAt", () => {
    const resetAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 60,
              percentLeft: 40,
              resetText: null, // No resetText
              resetMs: 3 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // All windows now get fallback text generation when resetText is null but resetAt exists
    expect(document.querySelector(".usage-window-reset")).toBeInTheDocument();
  });

  // formatResetAt boundary regression tests
  it("resetAt exactly 7 calendar days away shows weekday format, not month/day", () => {
    // Construct a date exactly 7 calendar days from now at an arbitrary time
    const now = new Date();
    const resetAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 7,
      14, 30, 0, 0 // 2:30 PM seven days from now
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Session",
              percentUsed: 20,
              percentLeft: 80,
              resetText: "resets in 7d",
              resetMs: 7 * 24 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const resetAtEl = document.querySelector(".usage-window-reset-at");
    expect(resetAtEl).toBeInTheDocument();
    // Should show weekday format like "Mon 2:30 PM", NOT "Apr 13, 2:30 PM"
    expect(resetAtEl?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
    // Should NOT contain a comma (which would indicate month/day format)
    expect(resetAtEl?.textContent).not.toMatch(/,/);
  });

  it("resetAt just under 7 days shows weekday format regardless of time-of-day", () => {
    // 6 days + 23 hours — time-of-day rounding could previously cause this
    // to flip between weekday and month/day format
    const now = new Date();
    const resetAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 6,
      now.getHours() + 23,
      now.getMinutes(),
      now.getSeconds()
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Session",
              percentUsed: 30,
              percentLeft: 70,
              resetText: "resets in 6d",
              resetMs: 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const resetAtEl = document.querySelector(".usage-window-reset-at");
    expect(resetAtEl).toBeInTheDocument();
    // Should show weekday format like "Sat 3:45 PM"
    expect(resetAtEl?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
  });

  it("resetAt 8 calendar days away shows month/day format", () => {
    const now = new Date();
    const resetAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 8,
      10, 0, 0, 0
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Weekly",
              percentUsed: 10,
              percentLeft: 90,
              resetText: "resets in 8d",
              resetMs: 8 * 24 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const resetAtEl = document.querySelector(".usage-window-reset-at");
    expect(resetAtEl).toBeInTheDocument();
    // Should show month/day format like "Apr 14, 10:00 AM"
    expect(resetAtEl?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
  });

  it("resetAt tomorrow consistently shows weekday format at any hour", () => {
    // Set the reset time to 1:00 AM tomorrow — previously edge-case for rounding
    const now = new Date();
    const resetAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      1, 0, 0, 0 // 1:00 AM tomorrow
    );

    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Codex",
          icon: "🟢",
          status: "ok",
          windows: [
            {
              label: "Session",
              percentUsed: 50,
              percentLeft: 50,
              resetText: "resets in 1d",
              resetMs: 24 * 60 * 60 * 1000,
              resetAt: resetAt.toISOString(),
            },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const resetAtEl = document.querySelector(".usage-window-reset-at");
    expect(resetAtEl).toBeInTheDocument();
    // Tomorrow should always be weekday format, never month/day
    expect(resetAtEl?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
  });

  // Email display tests
  it("does not render provider email even when email is present in data", () => {
    mockUseUsageData.mockReturnValue(createUsageDataState({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          email: "user@example.com",
          plan: "Pro",
          windows: [
            { label: "Session", percentUsed: 10, percentLeft: 90, resetText: "resets in 4h" },
          ],
        },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    }));

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Plan should be visible
    expect(screen.getByText("Pro")).toBeInTheDocument();
    // Email should NOT be rendered
    expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    expect(document.querySelector(".usage-provider-email")).not.toBeInTheDocument();
  });
});
