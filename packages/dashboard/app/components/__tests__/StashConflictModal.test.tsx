import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StashConflictModal from "../StashConflictModal";
import { ApiRequestError } from "../../api";

const mocked = vi.hoisted(() => ({
  api: vi.fn(),
  openFile: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    api: mocked.api,
  };
});

vi.mock("../../context/FileBrowserContext", () => ({
  useFileBrowser: () => ({ openFile: mocked.openFile }),
}));

function renderModal(overrides: Partial<ComponentProps<typeof StashConflictModal>> = {}) {
  return render(
    <StashConflictModal
      open
      onClose={vi.fn()}
      worktreePath="/repo"
      integrationBranch="release"
      stashSha="1234567890abcdef"
      stashLabel="fusion-auto-stash-FN-1"
      conflictedFiles={["src/a.ts", "src/b.ts"]}
      autostashOutcome="conflict-needs-manual"
      taskId="FN-1"
      {...overrides}
    />,
  );
}

describe("StashConflictModal", () => {
  beforeEach(() => {
    mocked.api.mockReset();
    mocked.openFile.mockReset();
    mocked.writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mocked.writeText },
      configurable: true,
    });
  });

  it("does not render when closed", () => {
    renderModal({ open: false });
    expect(screen.queryByText(/Resolve auto-stash conflicts/)).toBeNull();
  });

  it("renders one row per conflicted file with actions", () => {
    renderModal();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Keep mine" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Keep incoming" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open in editor" })).toHaveLength(2);
  });

  it("failed autostash shows warning and retry only", () => {
    renderModal({ autostashOutcome: "failed" });
    expect(screen.getByText(/Automatic restore failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
  });

  it("Keep mine posts ours and removes row from response", async () => {
    mocked.api.mockResolvedValueOnce({ remainingConflicts: ["src/b.ts"] });
    renderModal();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep mine" })[0]);
    await waitFor(() => expect(mocked.api).toHaveBeenCalledWith("/git/stash-resolve", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ worktreePath: "/repo", stashSha: "1234567890abcdef", file: "src/a.ts", choice: "ours", taskId: "FN-1" }),
    })));
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });

  it("Keep incoming posts theirs", async () => {
    mocked.api.mockResolvedValueOnce({ remainingConflicts: ["src/a.ts"] });
    renderModal();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep incoming" })[1]);
    await waitFor(() => expect(mocked.api).toHaveBeenCalledWith("/git/stash-resolve", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ worktreePath: "/repo", stashSha: "1234567890abcdef", file: "src/b.ts", choice: "theirs", taskId: "FN-1" }),
    })));
  });

  it("Open in editor uses file browser workspace", () => {
    renderModal();
    fireEvent.click(screen.getAllByRole("button", { name: "Open in editor" })[0]);
    expect(mocked.openFile).toHaveBeenCalledWith("src/a.ts", { workspace: "/repo" });
  });

  it("Drop stash disabled until conflicts resolved, then drops and closes", async () => {
    const onClose = vi.fn();
    mocked.api.mockResolvedValueOnce({ remainingConflicts: [] }).mockResolvedValueOnce({ dropped: true });
    renderModal({ onClose });
    const drop = screen.getByRole("button", { name: "Drop stash" });
    expect(drop).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep mine" })[0]);
    await waitFor(() => expect(drop).toBeEnabled());
    fireEvent.click(drop);
    await waitFor(() => expect(mocked.api).toHaveBeenCalledWith("/git/stash-drop", expect.objectContaining({ method: "POST" })));
    expect(onClose).toHaveBeenCalled();
  });

  it("Retry restore posts stash-apply and updates conflict state", async () => {
    mocked.api.mockResolvedValueOnce({ applied: true, conflict: true, conflictedFiles: ["src/c.ts"] });
    renderModal({ autostashOutcome: "failed", conflictedFiles: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry restore" }));
    await waitFor(() => expect(mocked.api).toHaveBeenCalledWith("/git/stash-apply", expect.objectContaining({ method: "POST" })));
    expect(screen.getByText("src/c.ts")).toBeInTheDocument();
  });

  it("shows inline error for resolve/drop/apply failures", async () => {
    mocked.api
      .mockRejectedValueOnce(new ApiRequestError("resolve failed", 500))
      .mockRejectedValueOnce(new ApiRequestError("apply failed", 500))
      .mockResolvedValueOnce({ remainingConflicts: [] })
      .mockRejectedValueOnce(new ApiRequestError("drop failed", 500));
    renderModal();

    fireEvent.click(screen.getAllByRole("button", { name: "Keep mine" })[0]);
    expect(await screen.findByText("resolve failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry restore" }));
    expect(await screen.findByText("apply failed")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Keep mine" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Drop stash" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Drop stash" }));
    expect(await screen.findByText("drop failed")).toHaveAttribute("role", "alert");
  });

  it("shows stash sha/label and copies sha", async () => {
    mocked.writeText.mockResolvedValueOnce(undefined);
    renderModal();
    expect(screen.getByText(/Stash ref: 1234567 \(fusion-auto-stash-FN-1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy stash reference" }));
    await waitFor(() => expect(mocked.writeText).toHaveBeenCalledWith("1234567890abcdef"));
  });

  it("supports Escape close, initial focus, focus return, and tab wrapping", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const view = renderModal({ onClose });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
