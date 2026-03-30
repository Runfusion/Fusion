import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsageIndicator } from "./UsageIndicator";
import * as useUsageDataModule from "../hooks/useUsageData";
import type { ProviderUsage } from "../api";

// Mock the useUsageData hook
vi.mock("../hooks/useUsageData", () => ({
  useUsageData: vi.fn(),
}));

const mockUseUsageData = vi.mocked(useUsageDataModule.useUsageData);

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
  });

  it("renders nothing when isOpen is false", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    const { container } = render(<UsageIndicator isOpen={false} onClose={mockOnClose} />);
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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByText("Failed to load usage data")).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch usage data")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("shows empty state when no providers", () => {
    mockUseUsageData.mockReturnValue({
      providers: [],
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByText("No AI providers configured")).toBeInTheDocument();
    expect(
      screen.getByText("Configure authentication in Settings to see usage data.")
    ).toBeInTheDocument();
  });

  it("calls refresh when refresh button clicked", async () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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
    const { unmount } = render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    expect(mockUseUsageData).toHaveBeenCalledWith({ autoRefresh: true });

    unmount();

    // Reset mock
    mockUseUsageData.mockClear();

    // When isOpen is false, autoRefresh should be false to prevent polling
    render(<UsageIndicator isOpen={false} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
    expect(screen.getByText(/10:30:00/)).toBeInTheDocument();
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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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
    localStorage.setItem("kb-usage-view-mode", "remaining");

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    const usedBtn = screen.getByTestId("usage-view-toggle-used");
    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    // Should initialize to 'remaining' from localStorage
    expect(remainingBtn).toHaveClass("active");
    expect(usedBtn).not.toHaveClass("active");
    expect(screen.getByText("55% remaining")).toBeInTheDocument();

    // Clean up
    localStorage.removeItem("kb-usage-view-mode");
  });

  it("persists view mode to localStorage when changed", () => {
    mockUseUsageData.mockReturnValue({
      providers: mockProviders,
      loading: false,
      error: null,
      lastUpdated: new Date(),
      refresh: mockRefresh,
    });

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    const remainingBtn = screen.getByTestId("usage-view-toggle-remaining");

    // Click remaining button
    fireEvent.click(remainingBtn);

    // Should save to localStorage
    expect(localStorage.getItem("kb-usage-view-mode")).toBe("remaining");

    // Clean up
    localStorage.removeItem("kb-usage-view-mode");
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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

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

    render(<UsageIndicator isOpen={true} onClose={mockOnClose} />);

    expect(document.querySelector('[data-provider="google"]')).toBeInTheDocument();
    expect(document.querySelector("svg[aria-label='Google Gemini']")).toBeInTheDocument();
  });
});
