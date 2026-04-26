import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsageIndicator } from "../UsageIndicator";
import * as useUsageDataModule from "../../hooks/useUsageData";
import type { ProviderUsage } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

// Mock the useUsageData hook
vi.mock("../../hooks/useUsageData", () => ({
  useUsageData: vi.fn(),
}));

const mockUseUsageData = vi.mocked(useUsageDataModule.useUsageData);
const TEST_PROJECT_ID = "proj-123";
const USAGE_VIEW_MODE_KEY = scopedKey("kb-usage-view-mode", TEST_PROJECT_ID);
const USAGE_HIDDEN_WINDOWS_KEY = scopedKey("kb-usage-hidden-windows", TEST_PROJECT_ID);

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
  });

  it("renders nothing when isOpen is false", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    const { container } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when isOpen is true", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByTestId("usage-modal")).toBeInTheDocument();
    expect(screen.getByText("Usage")).toBeInTheDocument();
  });

  it("renders provider cards with correct data", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Check provider names are rendered
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();

    // Check status badges
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Not configured")).toBeInTheDocument();

    // Check usage windows
    expect(screen.getByText("Session (5h)")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("Hourly")).toBeInTheDocument();
  });

  it("shows loading skeleton when loading", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: true,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton elements
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows error state when there is an error", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: "Failed to fetch usage data",
      lastUpdated: null,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("Failed to load usage data")).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch usage data")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows skeleton when no providers (empty result after fetch completes)", () => {
    // When useUsageData completes its initial fetch and returns empty providers,
    // we now show the skeleton (not the empty state) to indicate we're waiting
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton because initial fetch completed but returned empty
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("calls refresh when refresh button clicked", async () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const refreshBtn = screen.getByTestId("usage-refresh-btn");
    fireEvent.click(refreshBtn);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button clicked", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const closeBtn = screen.getByTestId("usage-modal-close");
    fireEvent.click(closeBtn);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when overlay is clicked", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const overlay = screen.getByTestId("usage-modal-overlay");
    fireEvent.click(overlay);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("renders progress bars with correct color classes", () => {
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: true,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const refreshBtn = screen.getByTestId("usage-refresh-btn");
    expect(refreshBtn).toBeDisabled();
  });

  it("passes autoRefresh option based on isOpen prop", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

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

  it("renders provider error messages", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Auth expired — run 'claude' to re-login")).toBeInTheDocument();
  });

  it("shows last updated timestamp", () => {
    const lastUpdated = new Date("2024-01-15T10:30:00");
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
    expect(screen.getByText(/10:30:00/)).toBeInTheDocument();
  });

  it("keeps footer metadata on the left and action buttons on the right", () => {
    const lastUpdated = new Date("2024-01-15T10:30:00");
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated,
      refresh: mockRefresh,
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("45% used")).toBeInTheDocument();
    expect(screen.getByText("55% left")).toBeInTheDocument();
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
  });

  // View mode toggle tests
  it("renders view mode toggle buttons with correct initial state", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const usedBtn = screen.getByTestId("usage-view-toggle-used");
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    expect(usedBtn).toBeInTheDocument();
    expect(remainingBtn).toBeInTheDocument();
    expect(usedBtn).toHaveClass("active");
    expect(remainingBtn).not.toHaveClass("active");
  });

  it("switches view mode when toggle buttons are clicked", () => {
    mockUseUsageData.mockReturnValue({
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
    });

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

    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

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
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getAllByTestId("usage-window-hide-btn")).toHaveLength(3);
  });

  it("clicking eye icon hides a window row", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    const hiddenRow = screen.getByText("Session (5h)").closest(".usage-window");
    expect(hiddenRow).toHaveClass("usage-window--hidden");
    expect(screen.queryByText("45% used")).not.toBeInTheDocument();
  });

  it("persists hidden windows to localStorage", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    expect(localStorage.getItem(USAGE_HIDDEN_WINDOWS_KEY)).toBe(
      JSON.stringify({ Anthropic: ["Session (5h)"] })
    );
  });

  it("restores hidden windows from localStorage on mount", () => {
    localStorage.setItem(
      USAGE_HIDDEN_WINDOWS_KEY,
      JSON.stringify({ Anthropic: ["Session (5h)"] })
    );

    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const hiddenRow = screen.getByText("Session (5h)").closest(".usage-window");
    expect(hiddenRow).toHaveClass("usage-window--hidden");
  });

  it("shows provider-level show hidden button when windows are hidden", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));

    expect(screen.getByTestId("usage-show-hidden-btn")).toHaveTextContent("Show hidden (1)");
  });

  it("show hidden button reveals all hidden windows for a provider", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Weekly" }));

    fireEvent.click(screen.getByTestId("usage-show-hidden-btn"));

    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
    expect(screen.getByText("Session (5h)").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
    expect(screen.getByText("Weekly").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
  });

  it("does not show provider-level show hidden button when no windows are hidden", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.queryByTestId("usage-show-hidden-btn")).not.toBeInTheDocument();
  });

  it("allows un-hiding a specific hidden window", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Session (5h)" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Session (5h)" }));

    expect(screen.getByText("Session (5h)").closest(".usage-window")).not.toHaveClass("usage-window--hidden");
  });

  // ProviderIcon integration tests
  it("renders SVG provider icons instead of emoji", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Anthropic", icon: "🅰️", status: "ok", windows: [] },
        { name: "OpenAI", icon: "🤖", status: "ok", windows: [] },
        { name: "Google", icon: "🔍", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should render SVG icons with correct provider data attributes
    expect(document.querySelector('[data-provider="anthropic"]')).toBeInTheDocument();
    expect(document.querySelector('[data-provider="openai"]')).toBeInTheDocument();
    expect(document.querySelector('[data-provider="google"]')).toBeInTheDocument();
  });

  it("maps Claude provider to anthropic icon", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Claude", icon: "🅰️", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="anthropic"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='Anthropic']")).toBeInTheDocument();
  });

  it("maps Codex provider to openai icon", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Codex", icon: "🤖", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="openai"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='OpenAI']")).toBeInTheDocument();
  });

  it("maps Gemini provider to google icon", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Gemini", icon: "🔍", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="google"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='Google Gemini']")).toBeInTheDocument();
  });

  it("maps Kimi provider to kimi icon", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Kimi", icon: "🌙", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="kimi"]')).toBeInTheDocument();
  });

  it("maps Moonshot provider to kimi icon (alias)", () => {
    mockUseUsageData.mockReturnValue({
      providers: [
        { name: "Moonshot", icon: "🌙", status: "ok", windows: [] },
      ],
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(document.querySelector('[data-provider="kimi"]')).toBeInTheDocument();
    expect(screen.getByText("Moonshot")).toBeInTheDocument();
  });

  // Pace indicator tests
  it("renders pace marker for weekly windows with timing data", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarker = document.querySelector('[data-testid="pace-marker"]');
    expect(paceMarker).toBeInTheDocument();
  });

  it("does not render pace marker for non-weekly windows (Session, Hourly)", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarkers = document.querySelectorAll('[data-testid="pace-marker"]');
    expect(paceMarkers.length).toBe(0);
  });

  it("does not render pace marker when pace is undefined", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceMarker = document.querySelector('[data-testid="pace-marker"]');
    expect(paceMarker).not.toBeInTheDocument();
  });

  it("shows 'ahead of pace' text when usage exceeds elapsed time by >5%", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/over pace/);
    expect(paceRow).toHaveTextContent("20%");
  });

  it("shows 'behind pace' text when usage is under elapsed time by >5%", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/under pace/);
    expect(paceRow).toHaveTextContent("30%");
  });

  it("shows 'on pace' text when usage is within 5% of elapsed time", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const paceRow = screen.getByTestId("pace-row");
    expect(paceRow).toHaveTextContent(/On pace/);
  });

  it("pace marker position inverts correctly when switching to remaining mode", () => {
    // Mock provider with weekly window
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: null, // No recent update, should refresh
      refresh: mockRefresh,
    });

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Initially isOpen is false, refresh should not be called
    expect(mockRefresh).not.toHaveBeenCalled();

    // Open the modal - isOpen transitions to true
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should be called when modal opens
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not call refresh when isOpen is already true on mount", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    // Render with isOpen=true initially
    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should NOT be called on initial mount when isOpen is already true
    // (the hook will handle initial data fetch)
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("does not call refresh when isOpen becomes false (modal closes)", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

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

    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: recentUpdate,
      refresh: mockRefresh,
    });

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

    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: staleUpdate,
      refresh: mockRefresh,
    });

    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Clear any calls from initial render
    mockRefresh.mockClear();

    // Open the modal
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // refresh should be called because data is stale (older than 5 seconds)
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls refresh again when modal reopens after being closed", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

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
    // Simulate: initial fetch has not completed, providers array is empty
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false, // loading is false, but no providers yet
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton because initial fetch hasn't completed
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows skeleton when modal reopens after being closed with data", () => {
    const { rerender } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // First open: show data
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show providers, not skeleton
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(document.querySelector(".usage-skeleton")).not.toBeInTheDocument();

    // Close the modal
    rerender(<UsageIndicator isOpen={false} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Reopen with no providers (simulating stale state before fetch completes)
    mockUseUsageData.mockReturnValue({
      providers: [], // Empty - will show skeleton until fetch completes
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton on reopen until providers arrive
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();
  });

  it("shows providers once data arrives after initial skeleton", () => {
    // First render: empty providers, no data yet
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    const { rerender } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show skeleton initially
    expect(document.querySelector(".usage-skeleton")).toBeInTheDocument();

    // Simulate data arriving
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    // Trigger a re-render with new data
    rerender(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Now should show providers
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(document.querySelector(".usage-skeleton")).not.toBeInTheDocument();
  });

  // Percentage rounding tests
  it("rounds percentage values in display text (whole numbers)", () => {
    // Use decimal percentages to verify rounding
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should display rounded values: 46% used, 54% left
    expect(screen.getByText("46% used")).toBeInTheDocument();
    expect(screen.getByText("54% left")).toBeInTheDocument();
  });

  it("rounds percentage values in remaining view mode", () => {
    // Use decimal percentages to verify rounding
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Switch to remaining mode
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");
    fireEvent.click(remainingBtn);

    // Should display rounded values: 67% remaining, 33% used
    expect(screen.getByText("67% remaining")).toBeInTheDocument();
    expect(screen.getByText("33% used")).toBeInTheDocument();
  });

  it("rounds percentage values in progress bar width", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Check progress bar width is rounded
    const progressBar = document.querySelector(".usage-progress-fill") as HTMLElement;
    expect(progressBar).toBeInTheDocument();
    expect(progressBar.style.width).toBe("46%"); // 45.678 rounds to 46
  });

  // resetAt timestamp display tests
  it("shows absolute reset time when resetAt is provided", () => {
    const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show both relative text and absolute time
    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  it("does not show absolute reset time when resetAt is absent", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 2h")).toBeInTheDocument();
    expect(document.querySelector(".usage-window-reset-at")).not.toBeInTheDocument();
  });

  it("Claude weekly window shows absolute reset time when resetAt is provided", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

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
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Relative reset text should be present for both weekly variants
    const resetTexts = screen.getAllByText("resets in 4d");
    expect(resetTexts.length).toBe(2);

    // Both weekly variants now show absolute timestamp
    expect(document.querySelectorAll(".usage-window-reset-at").length).toBe(2);
  });

  it("Anthropic provider name shows absolute reset time for weekly windows", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 3d")).toBeInTheDocument();
    // All providers now show the absolute reset time for all windows
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  it("non-Claude weekly windows still show absolute reset time when provided", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText("resets in 3d")).toBeInTheDocument();
    // Non-Claude weekly windows are unaffected — should still show absolute time
    expect(document.querySelector(".usage-window-reset-at")).toBeInTheDocument();
  });

  // Claude weekly reset fallback tests
  it("Claude weekly window generates fallback relative text when resetText is null but resetAt exists", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000); // 3d 5h
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Should show fallback "resets in Xd Xh" text
    expect(screen.getByText(/resets in \d+d \d+h/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows only days when no remainder hours", () => {
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // exactly 3d
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+d/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows hours when less than 1 day remaining", () => {
    const resetAt = new Date(Date.now() + 5 * 60 * 60 * 1000); // 5h
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+h/)).toBeInTheDocument();
  });

  it("Claude weekly window fallback shows minutes when less than 1 hour remaining", () => {
    const resetAt = new Date(Date.now() + 45 * 60 * 1000); // 45m
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    expect(screen.getByText(/resets in \d+m/)).toBeInTheDocument();
  });

  it("Claude weekly window does not show fallback when both resetText and resetAt are null", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // No reset text should be shown
    expect(document.querySelector(".usage-window-reset")).not.toBeInTheDocument();
  });

  it("Claude session window generates fallback reset text from resetAt", () => {
    const resetAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    mockUseUsageData.mockReturnValue({
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
    });

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

    mockUseUsageData.mockReturnValue({
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
    });

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

    mockUseUsageData.mockReturnValue({
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
    });

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

    mockUseUsageData.mockReturnValue({
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
    });

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

    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    const resetAtEl = document.querySelector(".usage-window-reset-at");
    expect(resetAtEl).toBeInTheDocument();
    // Tomorrow should always be weekday format, never month/day
    expect(resetAtEl?.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
  });

  // Email display tests
  it("does not render provider email even when email is present in data", () => {
    mockUseUsageData.mockReturnValue({
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
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} projectId={TEST_PROJECT_ID} />);

    // Plan should be visible
    expect(screen.getByText("Pro")).toBeInTheDocument();
    // Email should NOT be rendered
    expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();
    expect(document.querySelector(".usage-provider-email")).not.toBeInTheDocument();
  });
});
