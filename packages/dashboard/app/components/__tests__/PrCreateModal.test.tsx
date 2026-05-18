import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrCreateModal } from "../PrCreateModal";
import type { PrInfo } from "@fusion/core";

const mocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  fetchPrPreflight: vi.fn(),
  fetchPrOptions: vi.fn(),
  createPr: vi.fn(),
}));

vi.mock("../../api", () => ({
  generatePrMetadata: mocks.generatePrMetadata,
  fetchPrPreflight: mocks.fetchPrPreflight,
  fetchPrOptions: mocks.fetchPrOptions,
  createPr: mocks.createPr,
}));

const metadata = { title: "AI title", body: "## Summary\n\n## Changes\n\n## Testing\n\n## Linked Task\n", templateUsed: true };
const preflight = {
  branchOnRemote: true,
  commitsPresent: true,
  conflictsWithBase: false,
  ghAuthOk: true,
  defaultBaseBranch: "main",
  head: "fusion/FN-4756",
  commits: [{ sha: "abcdef1", subject: "feat", author: "dev" }],
  changedFiles: [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" as const }],
};
const options = {
  baseBranches: ["main", "develop"],
  reviewers: [{ login: "rev1", name: "Reviewer 1" }],
  assignees: [{ login: "assign1", name: "Assignee 1" }],
  labels: [{ name: "bug", color: "ff0000" }],
};

function renderModal(overrides?: Partial<ComponentProps<typeof PrCreateModal>>) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const addToast = vi.fn();
  render(
    <PrCreateModal
      open
      taskId="FN-4756"
      onClose={onClose}
      onCreated={onCreated}
      addToast={addToast}
      {...overrides}
    />,
  );
  return { onClose, onCreated, addToast };
}

describe("PrCreateModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generatePrMetadata.mockResolvedValue(metadata);
    mocks.fetchPrPreflight.mockResolvedValue(preflight);
    mocks.fetchPrOptions.mockResolvedValue(options);
    mocks.createPr.mockResolvedValue({ number: 12, title: "AI title", url: "url", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
  });

  it("renders nothing when closed", () => {
    render(<PrCreateModal open={false} taskId="FN-4756" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads metadata/preflight/options on open and renders key sections", async () => {
    renderModal();
    await waitFor(() => {
      expect(mocks.generatePrMetadata).toHaveBeenCalledTimes(1);
      expect(mocks.fetchPrPreflight).toHaveBeenCalledTimes(1);
      expect(mocks.fetchPrOptions).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    const bodyInput = (await screen.findByLabelText(/body/i)) as HTMLTextAreaElement;
    expect(bodyInput).toBeInTheDocument();
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("## Changes");
    expect(bodyInput.value).toContain("## Testing");
    expect(bodyInput.value).toContain("## Linked Task");

    expect(screen.getByText(/pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/create as draft/i)).toBeInTheDocument();
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expect(screen.getByText("Assignees")).toBeInTheDocument();
    expect(screen.getByText("Labels")).toBeInTheDocument();
    expect(screen.getByText(/diff & commit preview/i)).toBeInTheDocument();
    expect(screen.getByText("Commits")).toBeInTheDocument();
    expect(screen.getByText("Changed files")).toBeInTheDocument();
    expect(screen.getByText(/using/i)).toBeInTheDocument();
  });

  it("regenerates and reverts AI content", async () => {
    mocks.generatePrMetadata.mockResolvedValueOnce(metadata).mockResolvedValueOnce({ title: "New title", body: "New body", templateUsed: false });
    renderModal();
    const titleInput = await screen.findByDisplayValue("AI title");
    fireEvent.change(titleInput, { target: { value: "custom" } });
    expect(screen.getByRole("button", { name: /revert to ai version/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^regenerate$/i })[0]);
    await screen.findByDisplayValue("New title");
    fireEvent.change(screen.getByDisplayValue("New title"), { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: /revert to ai version/i }));
    expect(screen.getByDisplayValue("New title")).toBeInTheDocument();
  });

  it("disables submit when preflight fails and toggles draft label", async () => {
    mocks.fetchPrPreflight.mockResolvedValueOnce({ ...preflight, ghAuthOk: false });
    renderModal();
    const submitButton = await screen.findByRole("button", { name: "Create PR" });
    expect(submitButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/create as draft/i));
    expect(screen.getByRole("button", { name: "Create draft PR" })).toBeInTheDocument();
  });

  it("adds and removes chips and submits payload", async () => {
    const { onCreated, addToast, onClose } = renderModal();
    await screen.findByDisplayValue("AI title");

    fireEvent.change(screen.getByLabelText(/base branch/i), { target: { value: "develop" } });
    fireEvent.click(screen.getByLabelText(/create as draft/i));
    fireEvent.change(screen.getByPlaceholderText("Filter reviewers"), { target: { value: "rev" } });
    fireEvent.click(screen.getByRole("button", { name: /reviewer 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter assignees"), { target: { value: "assign" } });
    fireEvent.click(screen.getByRole("button", { name: /assignee 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter labels"), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("button", { name: "bug" }));

    const labelChip = screen.getByLabelText(/remove bug/i).closest("span");
    expect(labelChip).toHaveClass("pr-create-modal__chip--colored");
    expect(labelChip?.style.getPropertyValue("--pr-chip-label-color")).toBe("#ff0000");

    const reviewerChip = screen.getByLabelText(/remove reviewer 1/i).closest("span");
    expect(reviewerChip).not.toHaveClass("pr-create-modal__chip--colored");
    expect(reviewerChip?.style.getPropertyValue("--pr-chip-label-color")).toBe("");

    const assigneeChip = screen.getByLabelText(/remove assignee 1/i).closest("span");
    expect(assigneeChip).not.toHaveClass("pr-create-modal__chip--colored");
    expect(assigneeChip?.style.getPropertyValue("--pr-chip-label-color")).toBe("");

    const submitButton = screen.getByRole("button", { name: "Create draft PR" });
    expect(submitButton).toHaveClass("btn-primary");
    fireEvent.click(submitButton);

    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect(mocks.createPr.mock.calls[0][1]).toMatchObject({
      title: "AI title",
      body: metadata.body.trim(),
      base: "develop",
      draft: true,
      reviewers: ["rev1"],
      assignees: ["assign1"],
      labels: ["bug"],
    });
    expect(onCreated).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("Created PR #12", "success");
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /remove reviewer 1/i }));
  });

  it("shows submit error and retries with same payload", async () => {
    mocks.createPr.mockRejectedValueOnce(new Error("bad")).mockResolvedValueOnce({ number: 22, title: "ok", url: "u", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
    renderModal();
    await screen.findByDisplayValue("AI title");

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(await screen.findByText("bad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(2));
    expect(mocks.createPr.mock.calls[0][1]).toEqual(mocks.createPr.mock.calls[1][1]);
  });

  it("renders structured gh auth hint", async () => {
    const err = Object.assign(new Error("auth failed"), {
      details: {
        githubError: {
          code: "not-authenticated",
          message: "GitHub CLI is not authenticated.",
          hint: "Run 'gh auth login' to authenticate with GitHub.",
          action: { kind: "shell", command: "gh auth login" },
          retryable: true,
        },
      },
    });
    mocks.createPr.mockRejectedValueOnce(err);
    renderModal();
    await screen.findByDisplayValue("AI title");
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect((await screen.findAllByText(/gh auth login/i)).length).toBeGreaterThan(0);
  });

  it("closes on escape", async () => {
    const { onClose } = renderModal();
    await screen.findByDisplayValue("AI title");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
