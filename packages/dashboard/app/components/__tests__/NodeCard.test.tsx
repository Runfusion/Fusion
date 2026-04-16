import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodeCard } from "../NodeCard";
import type { NodeInfo, ProjectInfo } from "../../api";
import type { ComputedNodeSyncStatus } from "../../hooks/useNodeSettingsSync";

vi.mock("lucide-react", () => ({
  Activity: () => <span data-testid="activity-icon">activity</span>,
  Server: () => <span data-testid="server-icon">server</span>,
  Settings: () => <span data-testid="settings-icon">settings</span>,
  Trash2: () => <span data-testid="trash-icon">trash</span>,
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
    name: "Primary Node",
    type: "local",
    status: "online",
    maxConcurrent: 3,
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
    lastSyncAt: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
    diffCount: 0,
    ...overrides,
  };
}

describe("NodeCard", () => {
  it("renders node name, type, status, project count, and concurrency", () => {
    const node = makeNode({ id: "node-abc", name: "Build Worker", type: "remote", status: "connecting", url: "https://remote.example.com" });
    const projects = [
      makeProject({ id: "proj-a", nodeId: "node-abc" }),
      makeProject({ id: "proj-b", nodeId: "node-abc" }),
      makeProject({ id: "proj-c", nodeId: "other-node" }),
    ];

    render(
      <NodeCard
        node={node}
        projects={projects}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(screen.getByText("Build Worker")).toBeDefined();
    expect(screen.getByText("Remote")).toBeDefined();
    expect(screen.getByText("Connecting")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("https://remote.example.com")).toBeDefined();
  });

  it("maps status classes correctly", () => {
    const { rerender } = render(
      <NodeCard
        node={makeNode({ status: "online" })}
        projects={[]}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(screen.getByText("Online").className).toContain("node-card__status--online");

    rerender(
      <NodeCard
        node={makeNode({ status: "offline" })}
        projects={[]}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getByText("Offline").className).toContain("node-card__status--offline");

    rerender(
      <NodeCard
        node={makeNode({ status: "error" })}
        projects={[]}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getByText("Error").className).toContain("node-card__status--error");
  });

  it("fires health check and edit callbacks", () => {
    const node = makeNode();
    const onHealthCheck = vi.fn();
    const onEdit = vi.fn();

    render(
      <NodeCard
        node={node}
        projects={[]}
        onHealthCheck={onHealthCheck}
        onEdit={onEdit}
        onRemove={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("Run node health check"));
    expect(onHealthCheck).toHaveBeenCalledWith(node.id);

    fireEvent.click(screen.getByLabelText("Edit node"));
    expect(onEdit).toHaveBeenCalledWith(node);
  });

  it("requires a second click to confirm remove", () => {
    const onRemove = vi.fn();
    const node = makeNode();

    render(
      <NodeCard
        node={node}
        projects={[]}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={onRemove}
      />
    );

    const removeButton = screen.getByLabelText("Remove node");
    fireEvent.click(removeButton);

    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Confirm remove node"));
    expect(onRemove).toHaveBeenCalledWith(node.id);
  });

  it("local node counts include unassigned projects", () => {
    const localNode = makeNode({ id: "local-1", type: "local" });
    const projects = [
      makeProject({ id: "proj-1", nodeId: "local-1" }), // explicitly assigned
      makeProject({ id: "proj-2", nodeId: undefined }), // unassigned - runs on local
      makeProject({ id: "proj-3", nodeId: "remote-1" }), // assigned to remote - not counted
    ];

    render(
      <NodeCard
        node={localNode}
        projects={projects}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    // Local node should show 2 projects (explicitly assigned + unassigned)
    expect(screen.getByText("2")).toBeDefined();
  });

  it("remote node counts exclude unassigned projects", () => {
    const remoteNode = makeNode({ id: "remote-1", type: "remote" });
    const projects = [
      makeProject({ id: "proj-1", nodeId: "remote-1" }), // explicitly assigned
      makeProject({ id: "proj-2", nodeId: undefined }), // unassigned - NOT counted for remote
      makeProject({ id: "proj-3", nodeId: "local-1" }), // assigned to local - not counted
    ];

    render(
      <NodeCard
        node={remoteNode}
        projects={projects}
        onHealthCheck={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    // Remote node should show only 1 project (explicitly assigned only)
    expect(screen.getByText("1")).toBeDefined();
  });

  describe("multi-node scenarios", () => {
    it("renders remote node with long URL", () => {
      const longUrl = "https://this-is-a-very-long-hostname.example.com/some/very/long/path/to/resource";
      const node = makeNode({
        id: "node-long-url",
        name: "Long URL Node",
        type: "remote",
        url: longUrl,
        status: "online",
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      );

      // Node name should be visible
      expect(screen.getByText("Long URL Node")).toBeDefined();

      // URL should be visible (component may truncate it)
      expect(screen.getByText(/this-is-a-very-long-hostname/)).toBeDefined();
    });

    it("renders node with connecting status", () => {
      const node = makeNode({
        id: "node-connecting",
        name: "Connecting Node",
        type: "remote",
        url: "https://connecting.example.com",
        status: "connecting",
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      );

      expect(screen.getByText("Connecting Node")).toBeDefined();
      expect(screen.getByText("Connecting")).toBeDefined();
      expect(screen.getByText("Remote")).toBeDefined();
    });

    it("renders node with error status", () => {
      const node = makeNode({
        id: "node-error",
        name: "Error Node",
        type: "remote",
        url: "https://error.example.com",
        status: "error",
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      );

      expect(screen.getByText("Error Node")).toBeDefined();
      expect(screen.getByText("Error")).toBeDefined();
      expect(screen.getByText("Remote")).toBeDefined();
    });

    it("remove button arms on first click, removes on second click", () => {
      const onRemove = vi.fn();
      const node = makeNode({ id: "node-remove-test", name: "Remove Test Node" });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={onRemove}
        />
      );

      // First click arms the button (shows confirm)
      const removeButton = screen.getByLabelText("Remove node");
      fireEvent.click(removeButton);

      // Should show confirm text
      expect(screen.getByText("Confirm")).toBeDefined();
      expect(onRemove).not.toHaveBeenCalled();

      // Second click removes
      fireEvent.click(screen.getByLabelText("Confirm remove node"));
      expect(onRemove).toHaveBeenCalledWith(node.id);
    });

    it("disarms remove on clicking the armed button again", () => {
      const onRemove = vi.fn();
      const node = makeNode({ id: "node-disarm", name: "Disarm Test Node" });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={onRemove}
        />
      );

      // First click arms the button
      const removeButton = screen.getByLabelText("Remove node");
      fireEvent.click(removeButton);

      // Should show confirm text
      expect(screen.getByText("Confirm")).toBeDefined();

      // Click the armed button again to disarm (should not trigger remove)
      const armedButton = screen.getByLabelText("Confirm remove node");
      // Click the button again (third click) to disarm
      fireEvent.click(armedButton);

      // Should not call remove (it was disarmed, not confirmed)
      // The button should now be disarmed back to "Remove" state
      expect(screen.getByText("Remove")).toBeDefined();
      expect(screen.queryByText("Confirm")).not.toBeInTheDocument();
    });

    it("renders sample seed nodes correctly", () => {
      // Test the actual seed data nodes
      const seedNodes = [
        makeNode({ id: "node-staging-seed", name: "Staging Server X", type: "remote", url: "https://staging.runfusion.ai", status: "online", maxConcurrent: 4 }),
        makeNode({ id: "node-gpu-seed", name: "GPU Cluster Y", type: "remote", url: "https://gpu.runfusion.ai", status: "offline", maxConcurrent: 16 }),
        makeNode({ id: "node-dev-seed", name: "Dev Box Z", type: "remote", url: "http://192.168.1.100:4040", status: "error", maxConcurrent: 2 }),
      ];

      for (const node of seedNodes) {
        render(
          <NodeCard
            node={node}
            projects={[]}
            onHealthCheck={vi.fn()}
            onEdit={vi.fn()}
            onRemove={vi.fn()}
          />
        );

        // Verify node is rendered with correct data
        expect(screen.getByText(node.name, { exact: true })).toBeDefined();

        // Verify correct type badge
        const typeBadge = document.querySelector(".node-card__type-badge");
        expect(typeBadge?.textContent).toBe("Remote");

        // Verify correct status
        const statusClass = `.node-card__status--${node.status}`;
        const statusElement = document.querySelector(statusClass);
        expect(statusElement).toBeInTheDocument();

        // Clear between renders
        if (node !== seedNodes[seedNodes.length - 1]) {
          render(null as unknown as JSX.Element);
        }
      }
    });
  });

  describe("sync indicator", () => {
    it("renders sync indicator for remote nodes with synced state", () => {
      const node = makeNode({
        id: "node-synced",
        name: "Synced Node",
        type: "remote",
        url: "https://synced.example.com",
        status: "online",
      });
      const syncStatus = makeSyncStatus({ syncState: "synced" });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          syncStatus={syncStatus}
        />
      );

      const syncIndicator = screen.getByTestId("node-card-sync");
      expect(syncIndicator).toBeInTheDocument();
      expect(syncIndicator).toHaveAttribute("data-sync-state", "synced");
      expect(syncIndicator.textContent).toMatch(/Synced/);
    });

    it("does not render sync indicator for local nodes", () => {
      const node = makeNode({
        id: "node-local",
        name: "Local Node",
        type: "local",
        status: "online",
      });
      const syncStatus = makeSyncStatus();

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          syncStatus={syncStatus}
        />
      );

      expect(screen.queryByTestId("node-card-sync")).not.toBeInTheDocument();
    });

    it("does not render sync indicator when syncStatus is undefined", () => {
      const node = makeNode({
        id: "node-remote",
        name: "Remote Node",
        type: "remote",
        url: "https://remote.example.com",
        status: "online",
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      );

      expect(screen.queryByTestId("node-card-sync")).not.toBeInTheDocument();
    });

    it("renders error state dot for sync error", () => {
      const node = makeNode({
        id: "node-error-sync",
        name: "Error Sync Node",
        type: "remote",
        status: "online",
      });
      const syncStatus = makeSyncStatus({ syncState: "error" });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          syncStatus={syncStatus}
        />
      );

      const syncIndicator = screen.getByTestId("node-card-sync");
      expect(syncIndicator).toHaveAttribute("data-sync-state", "error");
    });

    it("renders 'Never synced' when lastSyncAt is null", () => {
      const node = makeNode({
        id: "node-never-synced",
        name: "Never Synced Node",
        type: "remote",
        status: "online",
      });
      const syncStatus = makeSyncStatus({
        syncState: "never-synced",
        lastSyncAt: null,
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          syncStatus={syncStatus}
        />
      );

      const syncIndicator = screen.getByTestId("node-card-sync");
      expect(syncIndicator.textContent).toContain("Never synced");
    });

    it("renders diff state correctly", () => {
      const node = makeNode({
        id: "node-diff",
        name: "Diff Node",
        type: "remote",
        status: "online",
      });
      const syncStatus = makeSyncStatus({
        syncState: "diff",
        diffCount: 5,
      });

      render(
        <NodeCard
          node={node}
          projects={[]}
          onHealthCheck={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          syncStatus={syncStatus}
        />
      );

      const syncIndicator = screen.getByTestId("node-card-sync");
      expect(syncIndicator).toHaveAttribute("data-sync-state", "diff");
    });
  });
});
