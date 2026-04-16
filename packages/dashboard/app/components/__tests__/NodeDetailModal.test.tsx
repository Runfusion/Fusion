import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NodeDetailModal } from "../NodeDetailModal";
import type { NodeInfo, ProjectInfo } from "../../api";
import type { ComputedNodeSyncStatus } from "../../hooks/useNodeSettingsSync";

vi.mock("lucide-react", () => ({
  Activity: () => <span data-testid="activity-icon">activity</span>,
  Download: () => <span data-testid="download-icon">download</span>,
  Pencil: () => <span data-testid="pencil-icon">pencil</span>,
  Save: () => <span data-testid="save-icon">save</span>,
  Shield: () => <span data-testid="shield-icon">shield</span>,
  Upload: () => <span data-testid="upload-icon">upload</span>,
  X: () => <span data-testid="x-icon">x</span>,
}));

vi.mock("../../hooks/useNodeSettingsSync", () => ({
  formatRelativeTime: vi.fn((ts: string | null) => {
    if (!ts) return "Never synced";
    return "Synced 2m ago";
  }),
  getSyncStateColor: vi.fn((state: string) => {
    switch (state) {
      case "synced": return "var(--color-success)";
      case "diff": return "var(--warning)";
      case "error": return "var(--color-error)";
      case "pending": return "var(--warning)";
      case "never-synced": return "var(--text-muted)";
      default: return "var(--text-muted)";
    }
  }),
}));

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
    name: "Test Node",
    type: "remote",
    status: "online",
    url: "https://test.example.com",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj-1",
    name: "Project One",
    path: "/workspace/project-one",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSyncStatus(overrides: Partial<ComputedNodeSyncStatus> = {}): ComputedNodeSyncStatus {
  return {
    syncState: "synced",
    lastSyncAt: new Date(Date.now() - 120000).toISOString(),
    diffCount: 0,
    ...overrides,
  };
}

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  node: makeNode(),
  projects: [],
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onHealthCheck: vi.fn().mockResolvedValue(undefined),
  addToast: vi.fn(),
};

describe("NodeDetailModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic rendering", () => {
    it("renders modal when isOpen is true", () => {
      render(<NodeDetailModal {...defaultProps} />);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("does not render modal when isOpen is false", () => {
      render(<NodeDetailModal {...defaultProps} isOpen={false} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders node name in dialog title", () => {
      const node = makeNode({ name: "Custom Node Name" });
      render(<NodeDetailModal {...defaultProps} node={node} />);
      expect(screen.getByRole("dialog", { name: "Node details for Custom Node Name" })).toBeInTheDocument();
    });

    it("renders Overview, Projects, Health, and Settings Sync sections for remote nodes", () => {
      render(<NodeDetailModal {...defaultProps} />);
      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText(/^Assigned Projects \(\d+\)$/)).toBeInTheDocument();
      expect(screen.getByText("Health")).toBeInTheDocument();
      expect(screen.getByText("Settings Sync")).toBeInTheDocument();
    });

    it("does not render Settings Sync section for local nodes", () => {
      const localNode = makeNode({ type: "local" });
      render(<NodeDetailModal {...defaultProps} node={localNode} />);
      expect(screen.getByText("Overview")).toBeInTheDocument();
      expect(screen.getByText(/^Projects \(\d+\)$/)).toBeInTheDocument();
      expect(screen.getByText("Health")).toBeInTheDocument();
      expect(screen.queryByText("Settings Sync")).not.toBeInTheDocument();
    });
  });

  describe("Settings Sync section", () => {
    it("renders Push Settings, Pull Settings, and Sync Auth buttons for remote nodes", () => {
      render(<NodeDetailModal {...defaultProps} />);
      expect(screen.getByText("Push Settings")).toBeInTheDocument();
      expect(screen.getByText("Pull Settings")).toBeInTheDocument();
      expect(screen.getByText("Sync Auth")).toBeInTheDocument();
    });

    it("displays sync status with last sync time", () => {
      const syncStatus = makeSyncStatus({ syncState: "synced" });
      render(<NodeDetailModal {...defaultProps} syncStatus={syncStatus} />);
      expect(screen.getByText(/Last sync:/)).toBeInTheDocument();
    });

    it("displays diff count when available", () => {
      const syncStatus = makeSyncStatus({ syncState: "diff", diffCount: 3 });
      render(<NodeDetailModal {...defaultProps} syncStatus={syncStatus} />);
      // The diff count is displayed with the "Differences:" label
      const diffElement = document.querySelector(".node-detail-modal__sync-diff");
      expect(diffElement).toBeInTheDocument();
      expect(diffElement?.textContent).toContain("Differences:");
      expect(diffElement?.textContent).toContain("3");
    });

    it("displays 'Never synced' when lastSyncAt is null", () => {
      const syncStatus = makeSyncStatus({ syncState: "never-synced", lastSyncAt: null });
      render(<NodeDetailModal {...defaultProps} syncStatus={syncStatus} />);
      expect(screen.getByText(/Never synced/)).toBeInTheDocument();
    });

    it("Push Settings button calls onPushSettings", async () => {
      const onPushSettings = vi.fn().mockResolvedValue(undefined);
      render(<NodeDetailModal {...defaultProps} onPushSettings={onPushSettings} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Push Settings"));
      });

      expect(onPushSettings).toHaveBeenCalledWith(defaultProps.node!.id);
    });

    it("Pull Settings button calls onPullSettings", async () => {
      const onPullSettings = vi.fn().mockResolvedValue(undefined);
      render(<NodeDetailModal {...defaultProps} onPullSettings={onPullSettings} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Pull Settings"));
      });

      expect(onPullSettings).toHaveBeenCalledWith(defaultProps.node!.id);
    });

    it("Sync Auth button calls onSyncAuth", async () => {
      const onSyncAuth = vi.fn().mockResolvedValue(undefined);
      render(<NodeDetailModal {...defaultProps} onSyncAuth={onSyncAuth} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Auth"));
      });

      expect(onSyncAuth).toHaveBeenCalledWith(defaultProps.node!.id);
    });

    it("shows loading state on Push Settings button during operation", async () => {
      const onPushSettings = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      render(<NodeDetailModal {...defaultProps} onPushSettings={onPushSettings} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Push Settings"));
      });

      expect(screen.getByText("Pushing...")).toBeInTheDocument();
    });

    it("shows loading state on Pull Settings button during operation", async () => {
      const onPullSettings = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      render(<NodeDetailModal {...defaultProps} onPullSettings={onPullSettings} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Pull Settings"));
      });

      expect(screen.getByText("Pulling...")).toBeInTheDocument();
    });

    it("shows loading state on Sync Auth button during operation", async () => {
      const onSyncAuth = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      render(<NodeDetailModal {...defaultProps} onSyncAuth={onSyncAuth} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Auth"));
      });

      expect(screen.getByText("Syncing...")).toBeInTheDocument();
    });

    it("displays sync error when push operation fails", async () => {
      const onPushSettings = vi.fn().mockRejectedValue(new Error("Push failed: connection refused"));
      const addToast = vi.fn();
      render(
        <NodeDetailModal
          {...defaultProps}
          onPushSettings={onPushSettings}
          addToast={addToast}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Push Settings"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(screen.getByText(/Push failed: connection refused/)).toBeInTheDocument();
    });

    it("displays sync error when pull operation fails", async () => {
      const onPullSettings = vi.fn().mockRejectedValue(new Error("Pull failed: timeout"));
      const addToast = vi.fn();
      render(
        <NodeDetailModal
          {...defaultProps}
          onPullSettings={onPullSettings}
          addToast={addToast}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Pull Settings"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(screen.getByText(/Pull failed: timeout/)).toBeInTheDocument();
    });

    it("displays sync error when auth sync operation fails", async () => {
      const onSyncAuth = vi.fn().mockRejectedValue(new Error("Auth sync failed"));
      const addToast = vi.fn();
      render(
        <NodeDetailModal
          {...defaultProps}
          onSyncAuth={onSyncAuth}
          addToast={addToast}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Auth"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(screen.getByText(/Auth sync failed/)).toBeInTheDocument();
    });

    it("dismisses sync error when dismiss button is clicked", async () => {
      const onPushSettings = vi.fn().mockRejectedValue(new Error("Push failed"));
      render(<NodeDetailModal {...defaultProps} onPushSettings={onPushSettings} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Push Settings"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(screen.getByText(/Push failed/)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Dismiss error"));
      });

      expect(screen.queryByText(/Push failed/)).not.toBeInTheDocument();
    });

    it("buttons are disabled when no handlers provided", () => {
      render(<NodeDetailModal {...defaultProps} />);
      expect(screen.getByText("Push Settings")).toBeDisabled();
      expect(screen.getByText("Pull Settings")).toBeDisabled();
      expect(screen.getByText("Sync Auth")).toBeDisabled();
    });
  });
});
