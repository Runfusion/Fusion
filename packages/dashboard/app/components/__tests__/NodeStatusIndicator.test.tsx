import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeStatusIndicator } from "../NodeStatusIndicator";
import type { NodeConfig } from "@fusion/core";

describe("NodeStatusIndicator", () => {
  describe("when node is null", () => {
    it("renders Local text badge", () => {
      render(<NodeStatusIndicator node={null} />);

      expect(screen.getByText("Local")).toBeInTheDocument();
      expect(screen.getByText("Local")).toHaveClass("node-status-indicator__label");
    });

    it("does not show details when showDetails is true but node is null", () => {
      render(<NodeStatusIndicator node={null} showDetails />);

      expect(screen.getByText("Local")).toBeInTheDocument();
      expect(screen.queryByText(/·/)).not.toBeInTheDocument();
    });
  });

  describe("when node type is local", () => {
    const localNode: NodeConfig = {
      id: "node_local",
      name: "Local Node",
      type: "local",
      status: "online",
      maxConcurrent: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("renders Local text badge", () => {
      render(<NodeStatusIndicator node={localNode} />);

      expect(screen.getByText("Local")).toBeInTheDocument();
    });

    it("does not show status dot for local nodes", () => {
      const { container } = render(<NodeStatusIndicator node={localNode} />);

      const dots = container.querySelectorAll(".node-status-indicator__dot");
      expect(dots).toHaveLength(0);
    });

    it("renders with --local modifier class", () => {
      render(<NodeStatusIndicator node={localNode} />);

      const container = screen.getByText("Local").closest(".node-status-indicator");
      expect(container).toHaveClass("node-status-indicator--local");
    });
  });

  describe("when node type is remote", () => {
    const remoteNode: NodeConfig = {
      id: "node_abc123",
      name: "Remote Server",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("renders node name", () => {
      render(<NodeStatusIndicator node={remoteNode} />);

      expect(screen.getByText("Remote Server")).toBeInTheDocument();
    });

    it("shows green dot for online status", () => {
      const { container } = render(<NodeStatusIndicator node={remoteNode} />);

      const dot = container.querySelector(".node-status-indicator__dot--online");
      expect(dot).toBeInTheDocument();
    });

    it("renders with --remote modifier class", () => {
      render(<NodeStatusIndicator node={remoteNode} />);

      const container = screen.getByText("Remote Server").closest(".node-status-indicator");
      expect(container).toHaveClass("node-status-indicator--remote");
    });

    it("shows red dot for offline status", () => {
      const offlineNode = { ...remoteNode, status: "offline" as const };
      const { container } = render(<NodeStatusIndicator node={offlineNode} />);

      const dot = container.querySelector(".node-status-indicator__dot--offline");
      expect(dot).toBeInTheDocument();
    });

    it("shows red dot for error status", () => {
      const errorNode = { ...remoteNode, status: "error" as const };
      const { container } = render(<NodeStatusIndicator node={errorNode} />);

      const dot = container.querySelector(".node-status-indicator__dot--error");
      expect(dot).toBeInTheDocument();
    });

    it("shows yellow spinner for connecting status", () => {
      const connectingNode = { ...remoteNode, status: "connecting" as const };
      const { container } = render(<NodeStatusIndicator node={connectingNode} />);

      const dot = container.querySelector(".node-status-indicator__dot--connecting");
      expect(dot).toBeInTheDocument();
      expect(dot?.querySelector(".node-status-indicator__spinner")).toBeInTheDocument();
    });
  });

  describe("showDetails option", () => {
    const remoteNode: NodeConfig = {
      id: "node_abc123",
      name: "Remote Server",
      type: "remote",
      url: "http://remote:4040",
      status: "online",
      maxConcurrent: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("does not show details by default", () => {
      render(<NodeStatusIndicator node={remoteNode} />);

      expect(screen.queryByText(/·/)).not.toBeInTheDocument();
    });

    it("shows details when showDetails is true", () => {
      render(<NodeStatusIndicator node={remoteNode} showDetails />);

      const details = screen.getByText(/remote · Online/);
      expect(details).toBeInTheDocument();
      expect(details).toHaveClass("node-status-indicator__details");
    });

    it("shows correct details for offline status", () => {
      const offlineNode = { ...remoteNode, status: "offline" as const };
      render(<NodeStatusIndicator node={offlineNode} showDetails />);

      const details = screen.getByText(/remote · Offline/);
      expect(details).toBeInTheDocument();
    });

    it("shows correct details for connecting status", () => {
      const connectingNode = { ...remoteNode, status: "connecting" as const };
      render(<NodeStatusIndicator node={connectingNode} showDetails />);

      const details = screen.getByText(/remote · Connecting/);
      expect(details).toBeInTheDocument();
    });
  });
});
