import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockerNodeOnboardingModal } from "../DockerNodeOnboardingModal";

describe("DockerNodeOnboardingModal", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only when open", () => {
    const { rerender } = render(<DockerNodeOnboardingModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<DockerNodeOnboardingModal {...defaultProps} isOpen />);
    expect(screen.getByRole("dialog", { name: "Docker node onboarding" })).toBeInTheDocument();
  });

  it("shows required fields by default", () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);
    expect(screen.getByPlaceholderText("my-docker-node")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Local Docker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remote Host" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Auto-generate" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Provide manually" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Claude CLI" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Droid CLI" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Keep data across container recreations" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Memory (MB)" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "CPUs" })).toBeInTheDocument();
  });

  it("toggles advanced section", () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);
    const advancedToggle = screen.getByRole("button", { name: "Advanced" });
    expect(advancedToggle).toHaveClass("docker-onboarding__advanced-toggle");
    expect(advancedToggle).not.toHaveClass("is-expanded");

    fireEvent.click(advancedToggle);
    expect(advancedToggle).toHaveClass("is-expanded");
    expect(screen.getByPlaceholderText("runfusion/fusion")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("latest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remote Host" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use TLS" }));
    expect(screen.getByPlaceholderText("/etc/docker/ca.pem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add variable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add mount" })).toBeInTheDocument();
  });

  it("validates required and minimum fields", async () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Docker Node" }));
    expect(await screen.findByText("Name is required and must be 64 characters or fewer")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("my-docker-node"), { target: { value: "n1" } });
    fireEvent.change(screen.getByPlaceholderText("http://localhost:4040"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Docker Node" }));
    expect(await screen.findByText("URL is required")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Memory (MB)" }), { target: { value: "256" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPUs" }), { target: { value: "0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Docker Node" }));
    expect(await screen.findByText("Memory must be at least 512 MB")).toBeInTheDocument();
    expect(await screen.findByText("CPUs must be at least 0.5")).toBeInTheDocument();
  });

  it("shows remote host and manual api key controls", () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Remote Host" }));
    expect(screen.getByPlaceholderText("tcp://host:2376")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Provide manually" }));
    expect(screen.getByPlaceholderText("Enter API key")).toBeInTheDocument();
  });

  it("submits valid input shape", async () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("my-docker-node"), { target: { value: "docker-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Remote Host" }));
    fireEvent.change(screen.getByPlaceholderText("http://localhost:4040"), { target: { value: "http://10.0.0.2:4040" } });
    fireEvent.change(screen.getByPlaceholderText("tcp://host:2376"), { target: { value: "tcp://10.0.0.2:2376" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude CLI" }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByPlaceholderText("KEY"), { target: { value: "A" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: "Create Docker Node" }));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "docker-a",
          reachableUrl: "http://10.0.0.2:4040",
          extraClis: ["claude-cli"],
          hostConfig: expect.objectContaining({ host: "tcp://10.0.0.2:2376" }),
          envVars: { A: "1" },
        }),
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it("shows creating state while submitting", async () => {
    let resolveSubmit = () => {};
    const slowSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    render(<DockerNodeOnboardingModal {...defaultProps} onSubmit={slowSubmit} />);
    fireEvent.change(screen.getByPlaceholderText("my-docker-node"), { target: { value: "node-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Docker Node" }));

    expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
    resolveSubmit();
  });

  it("closes on escape and cancel", () => {
    render(<DockerNodeOnboardingModal {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(2);
  });

  it("resets form when closed and reopened", () => {
    const { rerender } = render(<DockerNodeOnboardingModal {...defaultProps} />);
    fireEvent.change(screen.getByPlaceholderText("my-docker-node"), { target: { value: "changed" } });

    rerender(<DockerNodeOnboardingModal {...defaultProps} isOpen={false} />);
    rerender(<DockerNodeOnboardingModal {...defaultProps} isOpen />);

    expect(screen.getByPlaceholderText("my-docker-node")).toHaveValue("");
  });
});
