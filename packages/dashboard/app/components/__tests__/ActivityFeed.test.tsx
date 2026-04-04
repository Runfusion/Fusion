import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityFeed } from "../ActivityFeed";
import type { ActivityFeedEntry } from "../../api";

// Mock lucide-react icons
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    GitPullRequest: () => <span data-testid="pr-icon">PR</span>,
    GitMerge: () => <span data-testid="merge-icon">Merge</span>,
    CheckCircle: () => <span data-testid="check-icon">✓</span>,
    XCircle: () => <span data-testid="x-icon">✗</span>,
    Plus: () => <span data-testid="plus-icon">+</span>,
    ArrowRightLeft: () => <span data-testid="arrow-icon">→</span>,
    Settings: () => <span data-testid="settings-icon">⚙</span>,
    AlertTriangle: () => <span data-testid="alert-icon">⚠</span>,
    Folder: () => <span data-testid="folder-icon">📁</span>,
  };
});

function makeEntry(overrides: Partial<ActivityFeedEntry> = {}): ActivityFeedEntry {
  return {
    id: "entry_001",
    timestamp: new Date().toISOString(),
    type: "task:created",
    projectId: "proj_abc123",
    projectName: "Test Project",
    details: "Task created",
    ...overrides,
  };
}

describe("ActivityFeed", () => {
  it("renders empty state when no entries", () => {
    render(<ActivityFeed entries={[]} />);
    
    expect(screen.getByText("No recent activity")).toBeDefined();
    expect(screen.getByText(/Activity will appear here/)).toBeDefined();
  });

  it("renders custom empty message", () => {
    render(<ActivityFeed entries={[]} emptyMessage="Custom empty message" />);
    
    expect(screen.getByText("Custom empty message")).toBeDefined();
  });

  it("renders loading state", () => {
    const { container } = render(<ActivityFeed entries={[]} isLoading={true} />);
    
    expect(container.querySelector(".activity-feed-loading")).toBeDefined();
    expect(container.querySelector(".activity-feed-skeleton")).toBeDefined();
  });

  it("renders error state", () => {
    render(<ActivityFeed entries={[]} error="Failed to load activity" />);
    
    expect(screen.getByText("Failed to load activity")).toBeDefined();
  });

  it("renders activity entries", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ id: "entry_001", type: "task:created", details: "Created FN-001" }),
      makeEntry({ id: "entry_002", type: "task:moved", details: "Moved FN-002 to in-progress" }),
    ];
    
    render(<ActivityFeed entries={entries} />);
    
    expect(screen.getByText("Created")).toBeDefined();
    expect(screen.getByText("Moved")).toBeDefined();
    expect(screen.getByText("Created FN-001")).toBeDefined();
    expect(screen.getByText("Moved FN-002 to in-progress")).toBeDefined();
  });

  it("shows project names when provided", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ projectId: "proj_abc123", projectName: "Project Alpha" }),
    ];
    
    render(
      <ActivityFeed 
        entries={entries} 
        projectNames={{ "proj_abc123": "Project Alpha" }}
      />
    );
    
    expect(screen.getByText("Project Alpha")).toBeDefined();
  });

  it("displays task ID when available", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ taskId: "FN-042", taskTitle: "Fix bug" }),
    ];
    
    render(<ActivityFeed entries={entries} />);
    
    expect(screen.getByText("FN-042")).toBeDefined();
    expect(screen.getByText("Fix bug")).toBeDefined();
  });

  it("groups entries by date", () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    
    const entries: ActivityFeedEntry[] = [
      makeEntry({ id: "entry_001", timestamp: today }),
      makeEntry({ id: "entry_002", timestamp: yesterday }),
    ];
    
    const { container } = render(<ActivityFeed entries={entries} />);
    
    const groups = container.querySelectorAll(".activity-feed-group");
    expect(groups.length).toBe(2);
  });

  it("shows relative time for recent entries", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
    
    const entries: ActivityFeedEntry[] = [
      makeEntry({ timestamp: fiveMinutesAgo }),
    ];
    
    render(<ActivityFeed entries={entries} />);
    
    expect(screen.getByText("5m ago")).toBeDefined();
  });

  it("renders different event types with correct labels", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ id: "1", type: "task:created" }),
      makeEntry({ id: "2", type: "task:moved" }),
      makeEntry({ id: "3", type: "task:updated" }),
      makeEntry({ id: "4", type: "task:deleted" }),
      makeEntry({ id: "5", type: "task:merged" }),
      makeEntry({ id: "6", type: "task:failed" }),
      makeEntry({ id: "7", type: "settings:updated" }),
    ];
    
    render(<ActivityFeed entries={entries} />);
    
    expect(screen.getByText("Created")).toBeDefined();
    expect(screen.getByText("Moved")).toBeDefined();
    expect(screen.getByText("Updated")).toBeDefined();
    expect(screen.getByText("Deleted")).toBeDefined();
    expect(screen.getByText("Merged")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
    expect(screen.getByText("Settings")).toBeDefined();
  });

  it("renders with data-type attribute for styling", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ type: "task:created" }),
    ];
    
    const { container } = render(<ActivityFeed entries={entries} />);
    
    const item = container.querySelector('[data-type="task:created"]');
    expect(item).toBeDefined();
  });

  it("truncates long task titles", () => {
    const longTitle = "A".repeat(200);
    const entries: ActivityFeedEntry[] = [
      makeEntry({ taskTitle: longTitle }),
    ];
    
    const { container } = render(<ActivityFeed entries={entries} />);
    
    const titleEl = container.querySelector(".activity-feed-task-title");
    expect(titleEl).toBeDefined();
    expect(titleEl?.getAttribute("title")).toBe(longTitle);
  });

  it("shows full timestamp on hover via title attribute", () => {
    // Use a recent timestamp so it shows "ago" format
    const recentTime = new Date(Date.now() - 5 * 60000).toISOString();
    const entries: ActivityFeedEntry[] = [
      makeEntry({ timestamp: recentTime }),
    ];
    
    render(<ActivityFeed entries={entries} />);
    
    // Should show relative time like "5m ago"
    const timeEl = screen.getByText(/ago/);
    expect(timeEl).toBeDefined();
    // Title attribute should have full timestamp
    expect(timeEl.getAttribute("title")).toContain(":");
  });

  it("uses theme tokens for event type icon colors", () => {
    const entries: ActivityFeedEntry[] = [
      makeEntry({ id: "1", type: "task:deleted" }),
      makeEntry({ id: "2", type: "task:failed" }),
    ];

    const { container } = render(<ActivityFeed entries={entries} />);

    // Verify that deleted and failed events use --color-error (not undefined --error)
    const icons = container.querySelectorAll(".activity-feed-icon");
    expect(icons.length).toBeGreaterThanOrEqual(2);

    for (const icon of icons) {
      const style = (icon as HTMLElement).style;
      const color = style.color || style.getPropertyValue("color");
      // Should use var(--color-error), NOT var(--error) which is undefined
      expect(color).toContain("var(--color-error)");
      expect(color).not.toContain("var(--error)");
    }
  });
});
