import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DockerTargetSelector } from "../DockerTargetSelector";

vi.mock("lucide-react", () => ({ RefreshCw: () => null }));

const hookState = {
  contexts: [{ name: "default", isCurrentContext: true }],
  isLoadingContexts: false,
  contextsError: null,
  loadContexts: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn().mockResolvedValue({ success: true, dockerVersion: "24.0" }),
  isTestingConnection: false,
  lastTestResult: null,
  checkLocalDocker: vi.fn().mockResolvedValue({ available: true, version: "24.0" }),
  isCheckingLocal: false,
};

vi.mock("../../hooks/useDockerTargets", () => ({ useDockerTargets: () => hookState }));

describe("DockerTargetSelector", () => {
  it("renders modes and emits config", async () => {
    const onChange = vi.fn();
    render(<DockerTargetSelector onChange={onChange} />);

    expect(screen.getByText("Local Docker")).toBeInTheDocument();
    expect(screen.getByText("Docker Context")).toBeInTheDocument();
    expect(screen.getByText("Remote Host")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Docker Context"));
    await waitFor(() => expect(hookState.loadContexts).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Remote Host"));
    expect(screen.getByPlaceholderText("tcp://host:2376")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Test Connection"));
    await waitFor(() => expect(hookState.testConnection).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalled();
  });
});
