import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DockerProvisioningStatus } from "../DockerProvisioningStatus";
import type { DockerProvisionResult } from "@fusion/core";

vi.mock("lucide-react", () => ({
  CheckCircle: () => <span data-testid="icon-check">CheckCircle</span>,
  AlertCircle: () => <span data-testid="icon-alert">AlertCircle</span>,
  ExternalLink: () => <span data-testid="icon-external">ExternalLink</span>,
  RefreshCw: () => <span data-testid="icon-refresh">RefreshCw</span>,
  Terminal: () => <span data-testid="icon-terminal">Terminal</span>,
}));

describe("DockerProvisioningStatus", () => {
  describe("provisioning state", () => {
    it("renders spinner and stage text when isProvisioning=true", () => {
      const { container } = render(
        <DockerProvisioningStatus isProvisioning={true} />,
      );

      // Should show loading state with dots
      const dots = container.querySelectorAll(".provisioning-status__dot");
      expect(dots.length).toBe(3);

      expect(screen.getByText("Creating Docker node...")).toBeInTheDocument();
    });
  });

  describe("success state", () => {
    const successResult: DockerProvisionResult = {
      success: true,
      containerId: "abc123def456ghi789jkl012mno345pqr678",
      containerName: "fusion-test-abc12345",
      nodeId: "node_abc123",
      apiKey: "fn_testkey",
      portMapping: "4040:49152",
      durationMs: 2500,
    };

    it("renders success message and container ID", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={successResult}
        />,
      );

      expect(screen.getByText("Node created successfully!")).toBeInTheDocument();
      // Container ID is truncated (first 12 chars)
      expect(screen.getByText("abc123def456")).toBeInTheDocument();
      // Duration displayed
      expect(screen.getByText("Provisioned in 2.5s")).toBeInTheDocument();
    });

    it("renders View Node button when onViewNode is provided with nodeId", () => {
      const onViewNode = vi.fn();
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={successResult}
          onViewNode={onViewNode}
        />,
      );

      const button = screen.getByText("View Node");
      expect(button).toBeInTheDocument();

      fireEvent.click(button);
      expect(onViewNode).toHaveBeenCalledWith("node_abc123");
    });

    it("does not render View Node button without nodeId", () => {
      const onViewNode = vi.fn();
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={{ ...successResult, nodeId: undefined }}
          onViewNode={onViewNode}
        />,
      );

      expect(screen.queryByText("View Node")).not.toBeInTheDocument();
    });
  });

  describe("failure state", () => {
    const failureResult: DockerProvisionResult = {
      success: false,
      error: "Image pull failed: not found",
      failedStage: "image-pull",
      durationMs: 500,
    };

    it("renders error message and failed stage", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={failureResult}
        />,
      );

      expect(screen.getByText("Image pull failed: not found")).toBeInTheDocument();
      expect(screen.getByText("Failed at: image-pull")).toBeInTheDocument();
    });

    it("renders Retry button when onRetry is provided", () => {
      const onRetry = vi.fn();
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={failureResult}
          onRetry={onRetry}
        />,
      );

      const retryButton = screen.getByText("Retry");
      expect(retryButton).toBeInTheDocument();

      fireEvent.click(retryButton);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("does not render Retry button when onRetry is not provided", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={failureResult}
        />,
      );

      expect(screen.queryByText("Retry")).not.toBeInTheDocument();
    });

    it("renders docker logs hint when containerName is available", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={{
            ...failureResult,
            containerName: "fusion-test-abc12345",
          }}
        />,
      );

      expect(
        screen.getByText("docker logs fusion-test-abc12345"),
      ).toBeInTheDocument();
    });

    it("displays error from prop when result has no error", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={{ success: false }}
          error="Something went wrong"
        />,
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    it("displays fallback error message when no error is available", () => {
      render(
        <DockerProvisioningStatus
          isProvisioning={false}
          result={{ success: false }}
        />,
      );

      expect(screen.getByText("Provisioning failed")).toBeInTheDocument();
    });
  });
});
