import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrCreateModal } from "../PrCreateModal";
import type { PrInfo } from "@fusion/core";
import { readAppFile } from "../../test/cssFixture";

const prCreateModalCss = readAppFile("components/PrCreateModal.css");

const mocks = vi.hoisted(() => ({
  generatePrMetadata: vi.fn(),
  fetchPrPreflight: vi.fn(),
  fetchPrOptions: vi.fn(),
  createPr: vi.fn(),
  pushPrBranch: vi.fn(),
  resolvePrConflicts: vi.fn(),
}));

vi.mock("../../api", () => ({
  generatePrMetadata: mocks.generatePrMetadata,
  fetchPrPreflight: mocks.fetchPrPreflight,
  fetchPrOptions: mocks.fetchPrOptions,
  createPr: mocks.createPr,
  pushPrBranch: mocks.pushPrBranch,
  resolvePrConflicts: mocks.resolvePrConflicts,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

async function renderModalLoaded(overrides?: Partial<ComponentProps<typeof PrCreateModal>>) {
  const handles = renderModal(overrides);
  await screen.findByDisplayValue("AI title");
  return handles;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function stubPointerCapture(element: HTMLElement) {
  Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function expectMetadataLoadingAffordance() {
  const titleInput = screen.getByLabelText(/title/i);
  const bodyInput = screen.getByLabelText(/body/i);
  expect(screen.getByText(/generating ai title/i)).toBeInTheDocument();
  expect(screen.getByText(/generating ai body/i)).toBeInTheDocument();
  expect(screen.getByTestId("pr-title-loading-skeleton")).toBeInTheDocument();
  expect(screen.getByTestId("pr-body-loading-skeleton")).toBeInTheDocument();
  expect(titleInput).toBeDisabled();
  expect(bodyInput).toBeDisabled();
  expect(titleInput).toHaveAttribute("aria-busy", "true");
  expect(bodyInput).toHaveAttribute("aria-busy", "true");
}

function expectMetadataLoadingCleared() {
  const titleInput = screen.getByLabelText(/title/i);
  const bodyInput = screen.getByLabelText(/body/i);
  expect(screen.queryByText(/generating ai title/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/generating ai body/i)).not.toBeInTheDocument();
  expect(screen.queryByTestId("pr-title-loading-skeleton")).not.toBeInTheDocument();
  expect(screen.queryByTestId("pr-body-loading-skeleton")).not.toBeInTheDocument();
  expect(titleInput).toBeEnabled();
  expect(bodyInput).toBeEnabled();
  expect(titleInput).not.toHaveAttribute("aria-busy");
  expect(bodyInput).not.toHaveAttribute("aria-busy");
}

describe("PrCreateModal", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.generatePrMetadata.mockResolvedValue(metadata);
    mocks.fetchPrPreflight.mockResolvedValue(preflight);
    mocks.fetchPrOptions.mockResolvedValue(options);
    mocks.createPr.mockResolvedValue({ number: 12, title: "AI title", url: "url", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
    mocks.pushPrBranch.mockResolvedValue({ result: { pushed: true, head: "fusion/fn-4756", message: "Pushed fusion/fn-4756 to origin." }, preflight });
    mocks.resolvePrConflicts.mockResolvedValue({ result: { resolved: true, pushed: true, conflictedFiles: ["a.ts"], message: "resolved" }, preflight });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when closed", () => {
    render(<PrCreateModal open={false} taskId="FN-4756" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders inside the shared floating window and portals out of a container-type containing block", async () => {
    const { container } = render(
      <div data-testid="trap" style={{ containerType: "inline-size" }}>
        <PrCreateModal open taskId="FN-4756" onClose={vi.fn()} onCreated={vi.fn()} addToast={vi.fn()} />
      </div>,
    );

    await screen.findByDisplayValue("AI title");

    const trap = within(container).getByTestId("trap");
    expect(trap.querySelector('[role="dialog"]')).toBeNull();
    const panel = screen.getByTestId("floating-window-pr-create");
    expect(panel).toHaveClass("floating-window--pr-create", "floating-window--headerless");
    expect(panel.style.width).toBe("720px");
    expect(panel.style.height).toBe("680px");
    expect(screen.queryByTestId("floating-window-drag-handle-pr-create")).toBeNull();
    expect(panel.parentElement).toHaveClass("floating-window-overlay");
    expect(panel.parentElement?.parentElement).toBe(document.body);

    const dialog = screen.getByRole("dialog", { name: "Create Pull Request" });
    expect(dialog).toHaveClass("modal", "pr-create-modal");
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(dialog.querySelector(":scope > .modal-header")).toHaveClass("pr-create-modal__drag-handle");
    expect(dialog.querySelector(":scope > .modal-actions")?.parentElement).toBe(dialog);
  });

  it("drags and resizes the Create PR floating window from the embedded header", async () => {
    setViewport(1200, 1000);
    await renderModalLoaded();

    const panel = screen.getByTestId("floating-window-pr-create");
    const header = screen.getByRole("dialog", { name: "Create Pull Request" }).querySelector(".pr-create-modal__drag-handle") as HTMLElement;
    stubPointerCapture(panel);

    const initialLeft = Number.parseFloat(panel.style.left);
    const initialTop = Number.parseFloat(panel.style.top);

    act(() => {
      fireEvent.pointerDown(header, { pointerId: 7, clientX: 120, clientY: 80 });
      fireEvent.pointerMove(panel, { pointerId: 7, clientX: 220, clientY: 150 });
      fireEvent.pointerUp(panel, { pointerId: 7, clientX: 220, clientY: 150 });
    });

    await waitFor(() => {
      expect(Number.parseFloat(panel.style.left)).toBeGreaterThan(initialLeft);
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThan(initialTop);
    });

    const initialWidth = Number.parseFloat(panel.style.width);
    const initialHeight = Number.parseFloat(panel.style.height);
    const resizeHandle = screen.getByTestId("floating-window-resize-se") as HTMLElement;
    stubPointerCapture(resizeHandle);

    act(() => {
      fireEvent.pointerDown(resizeHandle, { pointerId: 8, clientX: 700, clientY: 600 });
      fireEvent.pointerMove(resizeHandle, { pointerId: 8, clientX: 820, clientY: 720 });
      fireEvent.pointerUp(resizeHandle, { pointerId: 8, clientX: 820, clientY: 720 });
    });

    await waitFor(() => {
      expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(initialWidth);
      expect(Number.parseFloat(panel.style.height)).toBeGreaterThan(initialHeight);
    });
  });

  it("keeps mobile Create PR full-screen and hides resize handles by CSS contract", () => {
    const mobileBlock = prCreateModalCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.floating-window--pr-create \.modal\.pr-create-modal\s*\{[\s\S]*?\n\}/)?.[0];

    expect(mobileBlock).toContain(".floating-window--pr-create");
    expect(mobileBlock).toContain("width: 100vw !important;");
    expect(mobileBlock).toContain("height: 100dvh !important;");
    expect(mobileBlock).toContain(".floating-window--pr-create .floating-window__resize-handle");
    expect(mobileBlock).toContain("display: none;");
  });

  it("portals independently of an outer modal overlay", async () => {
    const outerOnClose = vi.fn();
    const innerOnClose = vi.fn();

    const { container } = render(
      <div>
        <div className="modal-overlay open" data-testid="outer-overlay" onClick={outerOnClose}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Outer modal">Outer modal</div>
        </div>
        <div data-testid="outer-shell">
          <PrCreateModal open taskId="FN-4756" onClose={innerOnClose} onCreated={vi.fn()} addToast={vi.fn()} />
        </div>
      </div>,
    );

    await screen.findByDisplayValue("AI title");

    const outerShell = within(container).getByTestId("outer-shell");
    expect(outerShell.querySelector('[role="dialog"]')).toBeNull();

    const overlays = Array.from(document.body.querySelectorAll(".modal-overlay.open"));
    expect(overlays).toHaveLength(1);
    expect(screen.getByTestId("floating-window-pr-create")).toBeInTheDocument();

    const outerOverlay = within(container).getByTestId("outer-overlay");
    const innerDialog = screen.getByRole("dialog", { name: "Create Pull Request" });
    expect(outerOverlay.contains(innerDialog)).toBe(false);

    fireEvent.click(outerOverlay);
    expect(outerOnClose).toHaveBeenCalledTimes(1);
    expect(innerOnClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create Pull Request" })).toBeInTheDocument();
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

  it("defaults to raw edit mode and persists the body preview toggle preference", async () => {
    localStorage.setItem("fn-pr-create-body-preview", "true");

    await renderModalLoaded();

    expect(screen.queryByLabelText(/body/i, { selector: "textarea" })).toBeNull();
    expect(screen.getByRole("region", { name: "Body markdown preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument();
    const toggle = screen.getByTestId("pr-create-body-preview-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);

    expect(await screen.findByLabelText(/body/i, { selector: "textarea" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(localStorage.getItem("fn-pr-create-body-preview")).toBe("false"));
  });

  it("shows editable body by default and previews current markdown without mutating edits", async () => {
    await renderModalLoaded();

    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput).toHaveValue(metadata.body);
    expect(screen.queryByRole("region", { name: "Body markdown preview" })).toBeNull();

    fireEvent.change(bodyInput, { target: { value: "# Custom title\n\nPlain text body\n\n<details><summary>More</summary>Hidden</details>" } });
    const toggle = screen.getByTestId("pr-create-body-preview-toggle");
    fireEvent.click(toggle);

    expect(screen.queryByLabelText(/body/i, { selector: "textarea" })).toBeNull();
    expect(screen.getByRole("region", { name: "Body markdown preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Custom title" })).toBeInTheDocument();
    expect(screen.getByText("Plain text body")).toBeInTheDocument();
    expect(screen.getByText("More")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);

    expect(screen.getByLabelText(/body/i)).toHaveValue("# Custom title\n\nPlain text body\n\n<details><summary>More</summary>Hidden</details>");
  });

  it("renders empty and fallback body preview states without crashing", async () => {
    await renderModalLoaded();
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));

    const emptyPreview = screen.getByRole("region", { name: "Body markdown preview" });
    expect(emptyPreview).toBeInTheDocument();
    expect(screen.getByTestId("pr-create-body-preview-toggle")).toHaveAttribute("aria-pressed", "true");

    cleanup();
    localStorage.clear();
    mocks.generatePrMetadata.mockRejectedValueOnce(new Error("metadata blew up"));
    renderModal();

    expect(await screen.findByText("metadata blew up")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));

    expect(screen.getByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Linked Task" })).toBeInTheDocument();
    expect(screen.getByText("Closes FN-4756")).toBeInTheDocument();
  });

  it("re-renders preview for regenerate and Revert to AI version body changes", async () => {
    mocks.generatePrMetadata
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce({ title: "New title", body: "# Regenerated body\n\nFresh content", templateUsed: false });
    await renderModalLoaded();

    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));
    expect(screen.getByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /^regenerate$/i })[1]);

    expect(await screen.findByRole("heading", { level: 1, name: "Regenerated body" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Summary" })).toBeNull();
    expect(screen.getByText("Fresh content")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Plain edited body" } });
    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));
    expect(screen.getByText("Plain edited body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /revert to ai version/i }));

    expect(screen.getByRole("heading", { level: 1, name: "Regenerated body" })).toBeInTheDocument();
    expect(screen.queryByText("Plain edited body")).toBeNull();
  });

  it("submits the same body payload while markdown preview is active", async () => {
    await renderModalLoaded();
    const bodyText = "# Submit me\n\nPreview mode should not change payload.";
    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: bodyText } });
    fireEvent.click(screen.getByTestId("pr-create-body-preview-toggle"));

    expect(screen.getByRole("heading", { level: 1, name: "Submit me" })).toBeInTheDocument();
    const submitButton = screen.getByRole("button", { name: "Create PR" });
    await waitFor(() => expect(submitButton).toBeEnabled());
    fireEvent.click(submitButton);

    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect(mocks.createPr.mock.calls[0][1]).toMatchObject({
      title: "AI title",
      body: bodyText,
    });
  });

  it("renders commit preview rows in SHA, subject, author order", async () => {
    const commits = [
      {
        sha: "1234567890abcdef1234567890abcdef12345678",
        subject: "feat: add a very long subject that should use the flexible column instead of forcing the short SHA to wrap",
        author: "A very long author name that remains in the trailing column",
      },
      {
        sha: "abcdef0123456789abcdef0123456789abcdef01",
        subject: "fix: keep another subject readable",
        author: "dev",
      },
    ];
    mocks.fetchPrPreflight.mockResolvedValueOnce({
      ...preflight,
      commits,
      changedFiles: [
        { path: "src/very/long/path/that/should/still/use/the/file-row-flex-column.ts", additions: 10, deletions: 2, status: "modified" as const },
      ],
    });

    renderModal();
    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();

    const rows = Array.from(document.querySelectorAll<HTMLDivElement>(".pr-create-modal__commit-row"));
    expect(rows).toHaveLength(commits.length);
    rows.forEach((row, index) => {
      const codeCells = row.querySelectorAll("code");
      expect(codeCells).toHaveLength(1);
      expect(codeCells[0]).toHaveTextContent(commits[index]!.sha.slice(0, 7));
      expect(row.children).toHaveLength(3);
      expect(row.children[0]).toBe(codeCells[0]);
      expect(row.children[0]).toHaveTextContent(commits[index]!.sha.slice(0, 7));
      expect(row.children[1]).toHaveTextContent(commits[index]!.subject);
      expect(row.children[2]).toHaveTextContent(commits[index]!.author);
    });

    const fileRow = document.querySelector(".pr-create-modal__file-row");
    expect(fileRow?.children[0]).toHaveTextContent("src/very/long/path/that/should/still/use/the/file-row-flex-column.ts");
    expect(fileRow?.children[1]).toHaveTextContent("+10 / −2");
    expect(fileRow?.children[2]).toHaveTextContent("modified");
  });

  it("renders empty commit hint without commit rows", async () => {
    mocks.fetchPrPreflight.mockResolvedValueOnce({
      ...preflight,
      commitsPresent: false,
      commits: [],
    });

    renderModal();
    expect(await screen.findByText("No commits found.")).toBeInTheDocument();
    expect(document.querySelectorAll(".pr-create-modal__commit-row")).toHaveLength(0);
  });

  it("renders preflight and options while metadata shows a disabled loading affordance, then clears into AI content", async () => {
    const metadataDeferred = createDeferred<typeof metadata>();
    mocks.generatePrMetadata.mockReturnValueOnce(metadataDeferred.promise);

    renderModal();

    expect(await screen.findByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expectMetadataLoadingAffordance();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Filter reviewers"), { target: { value: "rev" } });
    fireEvent.click(screen.getByRole("button", { name: /reviewer 1/i }));
    expect(screen.getByRole("button", { name: /remove reviewer 1/i })).toBeInTheDocument();

    metadataDeferred.resolve(metadata);
    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expectMetadataLoadingCleared();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled();
  });

  it("keeps submit disabled while preflight is pending or failed", async () => {
    const preflightDeferred = createDeferred<typeof preflight>();
    mocks.fetchPrPreflight.mockReturnValueOnce(preflightDeferred.promise);

    renderModal();

    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    expect(screen.getByText(/loading pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();

    preflightDeferred.reject(new Error("preflight blew up"));
    expect(await screen.findByText("preflight blew up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
  });

  it("clears metadata loading affordance into the error and manual fallback state", async () => {
    const metadataDeferred = createDeferred<typeof metadata>();
    mocks.generatePrMetadata.mockReturnValueOnce(metadataDeferred.promise);
    renderModal();

    expect(await screen.findByText("Branch pushed to remote")).toBeInTheDocument();
    expectMetadataLoadingAffordance();

    metadataDeferred.reject(new Error("metadata blew up"));

    expect(await screen.findByText("metadata blew up")).toBeInTheDocument();
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();
    expectMetadataLoadingCleared();

    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("## Changes");
    expect(bodyInput.value).toContain("## Testing");
    expect(bodyInput.value).toContain("Closes FN-4756");

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Manual fallback title" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
  });

  it("times out hung metadata generation into the manual fallback state", async () => {
    vi.useFakeTimers();
    mocks.generatePrMetadata.mockReturnValueOnce(new Promise(() => {}));

    renderModal();

    expect(screen.getByText(/generating ai title/i)).toBeInTheDocument();
    expect(screen.getByText(/generating ai body/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(15001);
    });
    await act(async () => {
      await Promise.resolve();
    });
    vi.useRealTimers();

    expect(await screen.findByText("Timed out generating PR metadata")).toBeInTheDocument();
    expect(screen.queryByText(/generating ai title/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/generating ai body/i)).not.toBeInTheDocument();

    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("Closes FN-4756");
  });

  it("requires a non-empty body before submitting manual PR metadata", async () => {
    mocks.generatePrMetadata.mockRejectedValueOnce(new Error("metadata blew up"));
    renderModal();

    expect(await screen.findByText("metadata blew up")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Manual fallback title" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(mocks.createPr).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/body/i), { target: { value: "Manual fallback body" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
  });

  it("uses route fallback metadata as editable content after a timeout response", async () => {
    mocks.generatePrMetadata.mockResolvedValueOnce({
      title: "Fallback title",
      body: "## Summary\n\nSummary unavailable.\n\n## Changes\n\n- Details unavailable.\n\n## Testing\n\n- Not provided.\n\n## Linked Task\n\nCloses FN-4756",
      templateUsed: false,
    });
    renderModal();

    expect(await screen.findByDisplayValue("Fallback title")).toBeInTheDocument();
    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("## Summary");
    expect(bodyInput.value).toContain("Closes FN-4756");
    expect(screen.queryByText(/generating ai title/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled();
  });

  it("keeps options failure scoped so metadata and preflight still render", async () => {
    mocks.fetchPrOptions.mockRejectedValueOnce(new Error("options blew up"));
    renderModal();

    expect(await screen.findByDisplayValue("AI title")).toBeInTheDocument();
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(await screen.findByText("options blew up")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled();
  });

  it("renders empty option and preview states collapsed by default without throwing", async () => {
    mocks.fetchPrPreflight.mockResolvedValueOnce({ ...preflight, commits: [], changedFiles: [] });
    mocks.fetchPrOptions.mockResolvedValueOnce({ ...options, baseBranches: [], reviewers: [], assignees: [], labels: [] });

    await renderModalLoaded();

    const preview = document.querySelector(".pr-create-collapsible");
    expect(preview).toBeInstanceOf(HTMLDetailsElement);
    expect(preview).not.toHaveAttribute("open");
    expect(screen.getByText("No commits found.")).toBeInTheDocument();
    expect(screen.getByText("No changed files detected.")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeDisabled();
  });

  it("regenerates AI content without re-blocking preflight and options while restoring the loading affordance", async () => {
    const regenerateDeferred = createDeferred<typeof metadata>();
    mocks.generatePrMetadata.mockResolvedValueOnce(metadata).mockReturnValueOnce(regenerateDeferred.promise);
    await renderModalLoaded();
    const titleInput = screen.getByDisplayValue("AI title");
    fireEvent.change(titleInput, { target: { value: "custom" } });
    expect(screen.getByRole("button", { name: /revert to ai version/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^regenerate$/i })[0]);
    expect(screen.getByText("Branch pushed to remote")).toBeInTheDocument();
    expect(screen.getByLabelText(/base branch/i)).toBeEnabled();
    expectMetadataLoadingAffordance();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(mocks.createPr).not.toHaveBeenCalled();
    regenerateDeferred.resolve({ title: "New title", body: "New body", templateUsed: false });
    await screen.findByDisplayValue("New title");
    expectMetadataLoadingCleared();
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

  it("refreshes preflight independently when the base branch changes", async () => {
    const baseChangeDeferred = createDeferred<typeof preflight>();
    mocks.fetchPrPreflight
      .mockResolvedValueOnce(preflight)
      .mockReturnValueOnce(baseChangeDeferred.promise);

    await renderModalLoaded();

    fireEvent.change(screen.getByLabelText(/base branch/i), { target: { value: "develop" } });
    expect(mocks.fetchPrPreflight).toHaveBeenLastCalledWith("FN-4756", undefined, "develop");
    expect(screen.getByText(/loading pre-flight checks/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("AI title")).toBeInTheDocument();

    baseChangeDeferred.resolve({ ...preflight, defaultBaseBranch: "develop" });
    await waitFor(() => expect(screen.queryByText(/loading pre-flight checks/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/base branch/i)).toHaveValue("develop");
  });

  it("adds and removes chips and submits payload", async () => {
    const { onCreated, addToast, onClose } = await renderModalLoaded();

    fireEvent.change(screen.getByLabelText(/base branch/i), { target: { value: "develop" } });
    fireEvent.click(screen.getByLabelText(/create as draft/i));
    fireEvent.change(screen.getByPlaceholderText("Filter reviewers"), { target: { value: "rev" } });
    fireEvent.click(screen.getByRole("button", { name: /reviewer 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter assignees"), { target: { value: "assign" } });
    fireEvent.click(screen.getByRole("button", { name: /assignee 1/i }));
    fireEvent.change(screen.getByPlaceholderText("Filter labels"), { target: { value: "bug" } });
    fireEvent.click(screen.getByRole("button", { name: "bug" }));

    const submitButton = screen.getByRole("button", { name: "Create draft PR" });
    expect(submitButton).toHaveClass("btn-primary");
    await waitFor(() => expect(submitButton).toBeEnabled());
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

  it("renders push-branch affordance and enables submit after success", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    mocks.pushPrBranch.mockResolvedValueOnce({ result: { pushed: true, head: "fusion/fn-4756", message: "Pushed fusion/fn-4756 to origin." }, preflight });
    const { addToast } = await renderModalLoaded();

    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Push branch to remote" }));

    await waitFor(() => expect(mocks.pushPrBranch).toHaveBeenCalledWith("FN-4756", "main", undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    expect(addToast).toHaveBeenCalledWith("Pushed fusion/fn-4756 to origin.", "success");
  });

  it("surfaces push-branch failures", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    mocks.pushPrBranch.mockRejectedValueOnce(new Error("unable to push branch"));
    await renderModalLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Push branch to remote" }));

    expect(await screen.findByText("unable to push branch")).toBeInTheDocument();
  });

  it("keeps the push-branch remediation usable on narrow mobile widths", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, branchOnRemote: false });
    const originalInnerWidth = window.innerWidth;

    await act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
      window.dispatchEvent(new Event("resize"));
    });

    await renderModalLoaded();

    expect(screen.getByRole("button", { name: "Push branch to remote" })).toBeVisible();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    window.dispatchEvent(new Event("resize"));
  });

  it("renders AI conflict resolution affordance and enables submit after success", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, conflictsWithBase: true, branchOnRemote: false });
    mocks.resolvePrConflicts.mockResolvedValueOnce({ result: { resolved: true, pushed: true, conflictedFiles: ["a.ts"], message: "resolved" }, preflight });
    const { addToast } = await renderModalLoaded();

    const submitButton = screen.getByRole("button", { name: "Create PR" });
    expect(submitButton).toBeDisabled();
    const resolveButton = await screen.findByRole("button", { name: "Resolve conflicts with AI" });

    fireEvent.click(resolveButton);

    await waitFor(() => expect(mocks.resolvePrConflicts).toHaveBeenCalledWith("FN-4756", "main", undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    expect(addToast).toHaveBeenCalledWith("Resolved PR conflicts and pushed branch", "success");
  });

  it("surfaces conflict resolution failures", async () => {
    mocks.fetchPrPreflight.mockResolvedValue({ ...preflight, conflictsWithBase: true });
    mocks.resolvePrConflicts.mockRejectedValueOnce(new Error("unable to resolve"));
    await renderModalLoaded();

    fireEvent.click(await screen.findByRole("button", { name: "Resolve conflicts with AI" }));

    expect(await screen.findByText("unable to resolve")).toBeInTheDocument();
  });

  it("shows submit error and retries with same payload", async () => {
    mocks.createPr.mockRejectedValueOnce(new Error("bad")).mockResolvedValueOnce({ number: 22, title: "ok", url: "u", status: "open", headBranch: "h", baseBranch: "main", commentCount: 0 } as PrInfo);
    await renderModalLoaded();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
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
    await renderModalLoaded();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() => expect(mocks.createPr).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/gh auth login/i)).length).toBeGreaterThan(0);
  });

  it("does not close from bare page clicks because the floating shell is non-blocking", async () => {
    const { onClose } = await renderModalLoaded();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("floating-window-pr-create")).toBeInTheDocument();
  });

  it("keeps self-removing inner controls from closing the floating modal", async () => {
    const { onClose } = await renderModalLoaded();

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: /revert to ai version/i }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create Pull Request" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("AI title")).toBeInTheDocument();
  });

  it("closes on escape, header close, and cancel", async () => {
    const escapeHandles = await renderModalLoaded();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(escapeHandles.onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const headerHandles = await renderModalLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(headerHandles.onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const cancelHandles = await renderModalLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelHandles.onClose).toHaveBeenCalledTimes(1);
  });
});
