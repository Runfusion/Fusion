import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizardModal } from "../SetupWizardModal";

/*
FNXC:ProjectSetup 2026-08-19-12:44:
Git-unavailable setup is fail-closed across every repository mode and viewport: the only
available actions are install/download or cancel/retry, and registration never receives a
bypass field for a project that cannot create task worktrees.
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

function chooseMode(mode: "existing" | "init" | "clone"): void {
  const labels = {
    existing: /use existing directory/i,
    init: /initialize new repository/i,
    clone: /clone git repository/i,
  };
  fireEvent.click(screen.getByRole("radio", { name: labels[mode] }));
}

async function fillAndSubmit(mode: "existing" | "init" | "clone"): Promise<void> {
  chooseMode(mode);
  const pathPlaceholder = mode === "clone"
    ? "/path/for/new-clone"
    : mode === "init" ? "/path/to/new-project" : "/path/to/your/project";
  fireEvent.change(screen.getByPlaceholderText(pathPlaceholder), {
    target: { value: "/tmp/demo-project" },
  });
  const nameInput = document.getElementById("project-name") as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: "Demo" } });
  if (mode === "clone") {
    fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/repo.git"), {
      target: { value: "https://github.com/example/demo.git" },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: /register project|initialize and register|clone and register/i }));
}

describe.each(["desktop", "mobile"] as const)("SetupWizardModal git-missing warning (%s)", (viewport) => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport === "mobile" ? 390 : 1280 });
    mockRegisterProject.mockReset().mockResolvedValue({ id: "proj_1", name: "Demo", path: "/tmp/demo-project" });
    mockFetchAuthStatus.mockReset();
    mockConfirmWithChoice.mockReset();
  });

  it.each(["existing", "init", "clone"] as const)("blocks %s registration when Git is unavailable", async (mode) => {
    mockFetchAuthStatus.mockResolvedValue({ providers: [], gitCli: { available: false, installUrl: "https://git-scm.com/downloads" } });
    mockConfirmWithChoice.mockResolvedValue("primary");
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    render(<SetupWizardModal onProjectRegistered={vi.fn()} includeAgentStep={false} />);
    await fillAndSubmit(mode);

    await waitFor(() => expect(mockConfirmWithChoice).toHaveBeenCalledTimes(1));
    expect(mockRegisterProject).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledWith("https://git-scm.com/downloads", "_blank");
    expect(mockConfirmWithChoice).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/git is not installed/i),
      confirmLabel: expect.stringMatching(/open git downloads/i),
      cancelLabel: expect.stringMatching(/cancel/i),
    }));
    expect(mockConfirmWithChoice.mock.calls[0]?.[0]).not.toHaveProperty("tertiaryLabel");
    windowOpen.mockRestore();
  });

  it("registers with Git available without the obsolete bypass payload", async () => {
    mockFetchAuthStatus.mockResolvedValue({ providers: [], gitCli: { available: true, version: "2.50.0", installUrl: "https://git-scm.com/downloads" } });

    render(<SetupWizardModal onProjectRegistered={vi.fn()} includeAgentStep={false} />);
    await fillAndSubmit("existing");

    await waitFor(() => expect(mockRegisterProject).toHaveBeenCalledTimes(1));
    expect(mockRegisterProject.mock.calls[0]?.[0]).not.toHaveProperty("skipGitInit");
    expect(mockConfirmWithChoice).not.toHaveBeenCalled();
  });
});
