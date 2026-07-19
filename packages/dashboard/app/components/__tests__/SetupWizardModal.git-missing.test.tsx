import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizardModal } from "../SetupWizardModal";

/*
FNXC:ProjectSetup 2026-07-18-04:30:
Registering a project on a host without git used to fail AFTER submission with
a raw spawn error. The wizard must warn up front with an explicit choice:
open the git downloads, or create anyway without a git repo (skipGitInit).
*/

const mockRegisterProject = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockConfirmWithChoice = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerProject: (...args: unknown[]) => mockRegisterProject(...args),
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  detectWorkspace: vi.fn().mockResolvedValue({ repos: [], isWorkspace: false }),
  createAgent: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({
    confirm: vi.fn(),
    confirmWithChoice: (...args: unknown[]) => mockConfirmWithChoice(...args),
  }),
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: () => ({ nodes: [], loading: false }),
}));

async function fillAndSubmit(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText("/path/to/your/project"), {
    target: { value: "/tmp/demo-project" },
  });
  const nameInput = document.getElementById("project-name") as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: "Demo" } });
  fireEvent.click(screen.getByRole("button", { name: /register project/i }));
}

describe("SetupWizardModal git-missing warning", () => {
  beforeEach(() => {
    mockRegisterProject.mockReset().mockResolvedValue({ id: "proj_1", name: "Demo", path: "/tmp/demo-project" });
    mockFetchAuthStatus.mockReset();
    mockConfirmWithChoice.mockReset();
  });

  it("creates anyway with skipGitInit when the operator confirms", async () => {
    mockFetchAuthStatus.mockResolvedValue({ providers: [], gitCli: { available: false, installUrl: "https://git-scm.com/downloads" } });
    mockConfirmWithChoice.mockResolvedValue("primary");

    render(<SetupWizardModal onProjectRegistered={vi.fn()} includeAgentStep={false} />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({ skipGitInit: true }));
    });
    expect(mockConfirmWithChoice).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/git is not installed/i) }),
    );
  });

  it("opens the git downloads and aborts on the tertiary choice", async () => {
    mockFetchAuthStatus.mockResolvedValue({ providers: [], gitCli: { available: false, installUrl: "https://git-scm.com/downloads" } });
    mockConfirmWithChoice.mockResolvedValue("tertiary");
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    render(<SetupWizardModal onProjectRegistered={vi.fn()} includeAgentStep={false} />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(windowOpen).toHaveBeenCalledWith("https://git-scm.com/downloads", "_blank");
    });
    expect(mockRegisterProject).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it("registers without skipGitInit and without a dialog when git is available", async () => {
    mockFetchAuthStatus.mockResolvedValue({ providers: [], gitCli: { available: true, version: "2.50.0", installUrl: "https://git-scm.com/downloads" } });

    render(<SetupWizardModal onProjectRegistered={vi.fn()} includeAgentStep={false} />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(mockRegisterProject).toHaveBeenCalledWith(expect.objectContaining({ skipGitInit: undefined }));
    });
    expect(mockConfirmWithChoice).not.toHaveBeenCalled();
  });
});
