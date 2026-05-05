import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NodeDetailModal } from "../NodeDetailModal";
import type { DockerNodeConfig, ManagedDockerNodeInfo, NodeInfo, ProjectInfo } from "../../api";

vi.mock("lucide-react", () => ({
  Activity: () => <span>activity</span>,
  Download: () => <span>download</span>,
  Eye: () => <span>eye</span>,
  EyeOff: () => <span>eye-off</span>,
  FileText: () => <span>file-text</span>,
  Pencil: () => <span>pencil</span>,
  Play: () => <span>play</span>,
  RotateCcw: () => <span>rotate</span>,
  Save: () => <span>save</span>,
  Shield: () => <span>shield</span>,
  Square: () => <span>square</span>,
  Upload: () => <span>upload</span>,
  X: () => <span>x</span>,
  ChevronDown: () => <span>chevron</span>,
}));

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
    name: "Node 1",
    type: "remote",
    status: "online",
    url: "http://localhost:7777",
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDockerNode(overrides: Partial<ManagedDockerNodeInfo> = {}): ManagedDockerNodeInfo {
  return {
    id: "mdn-1",
    nodeId: "node-1",
    name: "Docker Node",
    containerId: "abcdef1234567890",
    status: "running",
    hostConfig: { type: "local" },
    envVars: { FUSION_TOKEN: "secret", FUSION_LOG_LEVEL: "info" },
    reachableUrl: "http://localhost:7777",
    imageName: "runfusion/fusion",
    imageTag: "latest",
    volumeMounts: [{ hostPath: "/host", containerPath: "/data", readOnly: true }],
    persistentStorage: true,
    resourceSizing: { cpuLimit: "2", memoryLimit: "4GB" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const baseProps = {
  isOpen: true,
  onClose: vi.fn(),
  node: makeNode(),
  projects: [] as ProjectInfo[],
  onUpdate: vi.fn().mockResolvedValue(undefined),
  onHealthCheck: vi.fn().mockResolvedValue(undefined),
  addToast: vi.fn(),
};

const dockerConfig: DockerNodeConfig = {
  image: "runfusion/fusion:latest",
  volumeMounts: [{ hostPath: "fusion-data", containerPath: "/app/.fusion", mode: "rw", type: "volume" }],
  environment: { FUSION_TOKEN: "secret" },
  configVersion: 1,
  lastUpdated: "2026-01-01T00:00:00.000Z",
};

describe("NodeDetailModal docker section", () => {
  it("does not render docker section without managedDockerNode", () => {
    render(<NodeDetailModal {...baseProps} />);
    expect(screen.queryByText("Docker Management")).not.toBeInTheDocument();
  });

  it("renders docker section and disabled lifecycle actions", () => {
    render(<NodeDetailModal {...baseProps} managedDockerNode={makeDockerNode()} />);
    expect(screen.getByText("Docker Management")).toBeInTheDocument();
    const lifecycleButtons = screen.getAllByTitle("Available after FN-3113");
    expect(lifecycleButtons).toHaveLength(3);
    lifecycleButtons.forEach((button) => expect(button).toBeDisabled());
  });

  it("loads and displays logs", async () => {
    const onFetchLogs = vi.fn().mockResolvedValue("line-1\nline-2");
    render(<NodeDetailModal {...baseProps} managedDockerNode={makeDockerNode()} onFetchLogs={onFetchLogs} />);
    fireEvent.click(screen.getByRole("button", { name: /view logs/i }));
    expect(await screen.findByText((content) => content.includes("line-1") && content.includes("line-2"))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close logs"));
    await waitFor(() => expect(screen.queryByText("Container Logs")).not.toBeInTheDocument());
  });

  it("renders status card and info grid values", () => {
    render(
      <NodeDetailModal
        {...baseProps}
        managedDockerNode={makeDockerNode()}
        containerStatus={{ running: true, status: "running", startedAt: "2026-01-01T00:00:00.000Z" }}
      />,
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText(/Uptime:/)).toBeInTheDocument();
    expect(screen.getByText("runfusion/fusion:latest")).toBeInTheDocument();
    expect(screen.getByText("abcdef123456")).toBeInTheDocument();
    expect(screen.getByText("Local Docker")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("7777")).toBeInTheDocument();
    expect(screen.getByText("2 / 4GB")).toBeInTheDocument();
  });

  it("refreshes container status", async () => {
    const onFetchContainerStatus = vi.fn().mockResolvedValue({ running: false, status: "stopped", exitCode: 1 });
    render(
      <NodeDetailModal
        {...baseProps}
        managedDockerNode={makeDockerNode()}
        onFetchContainerStatus={onFetchContainerStatus}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh status/i }));
    await waitFor(() => expect(onFetchContainerStatus).toHaveBeenCalledWith("mdn-1"));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Exit code: 1")).toBeInTheDocument();
  });

  it("renders docker config editor and saves", async () => {
    const onUpdateDockerConfig = vi.fn().mockResolvedValue({ ...dockerConfig, configVersion: 2 });
    const onFetchDockerConfigDiff = vi.fn().mockResolvedValue({ persistedVersion: 1, deployedVersion: null, needsRecreate: true });
    render(
      <NodeDetailModal
        {...baseProps}
        node={makeNode({ dockerConfig })}
        onUpdateDockerConfig={onUpdateDockerConfig}
        onFetchDockerConfigDiff={onFetchDockerConfigDiff}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /docker configuration/i }));
    expect(screen.getByText(/Config v1/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Needs Recreate")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /save docker config/i }));
    await waitFor(() => expect(onUpdateDockerConfig).toHaveBeenCalledWith("node-1", expect.objectContaining({ image: "runfusion/fusion:latest" })));
  });

  it("masks sensitive env values and shows read-only mount", () => {
    render(<NodeDetailModal {...baseProps} managedDockerNode={makeDockerNode()} />);
    fireEvent.click(screen.getByText("Environment Variables"));
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.getByText("info")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Volume Mounts"));
    expect(screen.getByText("/host → /data")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });
});
