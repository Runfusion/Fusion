import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChangesDiffModal, type NormalizedFile } from "../ChangesDiffModal";
import type { MergeDetails } from "@fusion/core";

vi.mock("lucide-react", () => ({
  X: ({ size }: any) => <span data-testid="icon-x">X</span>,
  FileCode: ({ size, opacity }: any) => (
    <span data-testid="icon-filecode">FileCode</span>
  ),
  ChevronLeft: ({ size }: any) => <span data-testid="icon-chevron-left" />,
  ChevronRight: ({ size }: any) => <span data-testid="icon-chevron-right" />,
  WrapText: ({ size }: any) => <span data-testid="icon-wraptext" />,
  RefreshCw: ({ size }: any) => <span data-testid="icon-refresh" />,
  GitCommit: ({ size }: any) => <span data-testid="icon-gitcommit" />,
}));

vi.mock("../../utils/highlightDiff", () => ({
  highlightDiff: (diff: string) => diff,
}));

const FILES: NormalizedFile[] = [
  {
    path: "src/app.ts",
    status: "modified",
    additions: 5,
    deletions: 2,
    patch: "@@ -1,3 +1,6 @@\n-old line\n+new line\n+another new line",
  },
  {
    path: "src/new-file.ts",
    status: "added",
    additions: 10,
    deletions: 0,
    patch: "@@ -0,0 +1,10 @@\n+export function hello() {\n+  return 'world';\n+}",
  },
  {
    path: "src/deleted.ts",
    status: "deleted",
    additions: 0,
    deletions: 8,
    patch: "@@ -1,8 +0,0 @@\n-old line 1\n-old line 2",
  },
];

const STATS = { filesChanged: 3, additions: 15, deletions: 10 };

const MERGE_DETAILS: MergeDetails = {
  commitSha: "abc1234567890def",
  filesChanged: 3,
  insertions: 15,
  deletions: 10,
  mergeCommitMessage: "Merge branch 'fusion/fn-001' into main",
  mergedAt: "2026-01-15T10:30:00Z",
};

const defaultProps = {
  isOpen: true,
  taskId: "FN-001",
  files: FILES,
  stats: STATS,
  onClose: vi.fn(),
  onRefresh: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ChangesDiffModal", () => {
  describe("rendering", () => {
    it("renders nothing when isOpen is false", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} isOpen={false} />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders the modal when isOpen is true", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByText(/Changes — FN-001/)).toBeTruthy();
    });

    it("shows total additions and deletions in header", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByText("+15")).toBeTruthy();
      expect(screen.getByText("-10")).toBeTruthy();
    });

    it("shows file list in sidebar", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      // File paths appear in both sidebar and diff header, so use getAllByText
      expect(screen.getAllByText("src/app.ts").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("src/new-file.ts").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("src/deleted.ts").length).toBeGreaterThanOrEqual(1);
    });

    it("shows status badges with correct labels", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} />,
      );

      const modifiedBadge = container.querySelector(
        ".changes-file-status--modified",
      );
      expect(modifiedBadge).toBeTruthy();
      expect(modifiedBadge?.textContent).toBe("M");

      const addedBadge = container.querySelector(
        ".changes-file-status--added",
      );
      expect(addedBadge).toBeTruthy();
      expect(addedBadge?.textContent).toBe("A");

      const deletedBadge = container.querySelector(
        ".changes-file-status--deleted",
      );
      expect(deletedBadge).toBeTruthy();
      expect(deletedBadge?.textContent).toBe("D");
    });

    it("shows per-file stats in the sidebar", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      // Each file item shows +X -Y stats
      const statElements = screen.getAllByText(/\+\d+ -\d+/);
      // 3 files in sidebar + 1 in diff header = at least 4
      expect(statElements.length).toBeGreaterThanOrEqual(4);
    });

    it("auto-selects the first file on open", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      // Should show the first file's name in the diff header (selected by useEffect)
      expect(
        screen.getByText("src/app.ts", {
          selector: ".changes-diff-file-header-name",
        }),
      ).toBeTruthy();
    });

    it("shows diff content for selected file", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} />,
      );
      // The first file's patch should be visible
      const patchEl = container.querySelector(".changes-diff-patch");
      expect(patchEl).toBeTruthy();
      expect(patchEl?.textContent).toContain("@@ -1,3 +1,6 @@");
    });

    it("shows 'No diff available' for file without patch", () => {
      const filesNoPatch: NormalizedFile[] = [
        {
          path: "src/binary.png",
          status: "added",
          additions: 0,
          deletions: 0,
          patch: "",
        },
      ];
      render(
        <ChangesDiffModal
          {...defaultProps}
          files={filesNoPatch}
        />,
      );
      expect(screen.getByText("No diff available for this file.")).toBeTruthy();
    });

    it("shows Select a file placeholder when files are initially empty", () => {
      render(
        <ChangesDiffModal {...defaultProps} files={[]} />,
      );

      // No files → "Select a file" placeholder
      expect(screen.getByText("Select a file to view its diff")).toBeTruthy();
    });
  });

  describe("file selection", () => {
    it("selects a file when clicking in sidebar", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Click on the second file in the sidebar
      const sidebarFileItems = screen.getAllByText("src/new-file.ts");
      // Click the one in the sidebar (the first match should be in the sidebar)
      fireEvent.click(sidebarFileItems[0]);

      // The diff header should now show the second file
      expect(
        screen.getByText("src/new-file.ts", {
          selector: ".changes-diff-file-header-name",
        }),
      ).toBeTruthy();
    });

    it("highlights the selected file in sidebar", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} />,
      );

      // First file should be selected by default
      const selectedItems = container.querySelectorAll(
        ".changes-diff-file-item.selected",
      );
      expect(selectedItems.length).toBe(1);
      expect(selectedItems[0].getAttribute("title")).toBe("src/app.ts");

      // Click on second file
      fireEvent.click(screen.getByText("src/new-file.ts"));

      const newSelectedItems = container.querySelectorAll(
        ".changes-diff-file-item.selected",
      );
      expect(newSelectedItems.length).toBe(1);
      expect(newSelectedItems[0].getAttribute("title")).toBe(
        "src/new-file.ts",
      );
    });
  });

  describe("navigation buttons", () => {
    it("renders Previous and Next navigation buttons", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByLabelText("Previous file")).toBeTruthy();
      expect(screen.getByLabelText("Next file")).toBeTruthy();
    });

    it("shows file position indicator", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      // First file selected by default → 1/3
      expect(screen.getByText("1/3")).toBeTruthy();
    });

    it("disables Previous button on first file", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByLabelText("Previous file")).toBeDisabled();
    });

    it("enables Next button on first file", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByLabelText("Next file")).not.toBeDisabled();
    });

    it("navigates to next file when Next is clicked", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      fireEvent.click(screen.getByLabelText("Next file"));
      expect(screen.getByText("2/3")).toBeTruthy();
    });

    it("disables Next button on last file", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Navigate to last file
      fireEvent.click(screen.getByLabelText("Next file")); // 2/3
      fireEvent.click(screen.getByLabelText("Next file")); // 3/3

      expect(screen.getByText("3/3")).toBeTruthy();
      expect(screen.getByLabelText("Next file")).toBeDisabled();
    });

    it("navigates to previous file when Previous is clicked", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Go to second file
      fireEvent.click(screen.getByLabelText("Next file"));
      expect(screen.getByText("2/3")).toBeTruthy();

      // Go back
      fireEvent.click(screen.getByLabelText("Previous file"));
      expect(screen.getByText("1/3")).toBeTruthy();
    });

    it("does not navigate below 0", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Already at first file, Previous is disabled
      expect(screen.getByLabelText("Previous file")).toBeDisabled();
      expect(screen.getByText("1/3")).toBeTruthy();
    });

    it("updates the diff content when navigating", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Navigate to second file
      fireEvent.click(screen.getByLabelText("Next file"));

      // Diff header should show second file name
      expect(
        screen.getByText("src/new-file.ts", {
          selector: ".changes-diff-file-header-name",
        }),
      ).toBeTruthy();
    });
  });

  describe("word wrap toggle", () => {
    it("renders the word wrap toggle button", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      expect(screen.getByLabelText("Toggle word wrap")).toBeTruthy();
    });

    it("defaults to word wrap ON", () => {
      render(<ChangesDiffModal {...defaultProps} />);
      const toggle = screen.getByLabelText("Toggle word wrap");
      expect(toggle.className).toContain("btn-primary");
    });

    it("toggles word wrap OFF when clicked", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} />,
      );

      const toggle = screen.getByLabelText("Toggle word wrap");
      fireEvent.click(toggle);

      // Should now have nowrap class
      const patchEl = container.querySelector(".changes-diff-patch");
      expect(patchEl?.classList.contains("changes-diff-patch--nowrap")).toBe(
        true,
      );
      expect(patchEl?.classList.contains("changes-diff-patch--wrap")).toBe(
        false,
      );
    });

    it("updates tooltip based on wrap state", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      const toggle = screen.getByLabelText("Toggle word wrap");
      expect(toggle.getAttribute("title")).toBe("Disable word wrap");

      fireEvent.click(toggle);
      expect(toggle.getAttribute("title")).toBe("Enable word wrap");
    });
  });

  describe("close behavior", () => {
    it("calls onClose when close button is clicked", () => {
      const onClose = vi.fn();
      render(<ChangesDiffModal {...defaultProps} onClose={onClose} />);

      // Click the close button (X icon)
      const closeBtn = screen.getByTestId("icon-x").closest("button");
      expect(closeBtn).toBeTruthy();
      fireEvent.click(closeBtn!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when clicking the modal overlay", () => {
      const onClose = vi.fn();
      const { container } = render(
        <ChangesDiffModal {...defaultProps} onClose={onClose} />,
      );

      const overlay = container.querySelector(".modal-overlay");
      expect(overlay).toBeTruthy();
      // Overlay dismiss is wired via mousedown→mouseup so a resize-drag that
      // ends on the overlay doesn't close the modal. A real click on the
      // overlay fires both events on the overlay element.
      fireEvent.mouseDown(overlay!);
      fireEvent.mouseUp(overlay!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does NOT call onClose when mousedown is on the modal but mouseup is on the overlay (resize drag)", () => {
      const onClose = vi.fn();
      const { container } = render(
        <ChangesDiffModal {...defaultProps} onClose={onClose} />,
      );

      const overlay = container.querySelector(".modal-overlay")!;
      const modal = container.querySelector(".changes-diff-modal")!;
      fireEvent.mouseDown(modal);
      fireEvent.mouseUp(overlay);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("does NOT call onClose when clicking inside the modal body", () => {
      const onClose = vi.fn();
      const { container } = render(
        <ChangesDiffModal {...defaultProps} onClose={onClose} />,
      );

      const modal = container.querySelector(".modal.changes-diff-modal");
      expect(modal).toBeTruthy();
      fireEvent.click(modal!);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose on Escape key", () => {
      const onClose = vi.fn();
      render(<ChangesDiffModal {...defaultProps} onClose={onClose} />);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not listen for Escape when modal is closed", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <ChangesDiffModal {...defaultProps} isOpen={false} onClose={onClose} />,
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("refresh button", () => {
    it("renders refresh button when onRefresh is provided", () => {
      const onRefresh = vi.fn();
      render(<ChangesDiffModal {...defaultProps} onRefresh={onRefresh} />);

      expect(screen.getByText("Refresh")).toBeTruthy();
    });

    it("does not render refresh button when onRefresh is not provided", () => {
      render(
        <ChangesDiffModal
          {...defaultProps}
          onRefresh={undefined}
        />,
      );

      expect(screen.queryByText("Refresh")).toBeNull();
    });

    it("calls onRefresh when refresh button is clicked", () => {
      const onRefresh = vi.fn();
      render(<ChangesDiffModal {...defaultProps} onRefresh={onRefresh} />);

      fireEvent.click(screen.getByText("Refresh"));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("commit metadata (done tasks)", () => {
    it("shows commit metadata when column is done and mergeDetails provided", () => {
      render(
        <ChangesDiffModal
          {...defaultProps}
          column="done"
          mergeDetails={MERGE_DETAILS}
        />,
      );

      expect(screen.getByText("abc1234")).toBeTruthy(); // short SHA
      expect(
        screen.getByText("Merge branch 'fusion/fn-001' into main"),
      ).toBeTruthy();
      expect(screen.getByText(/Merged .+/)).toBeTruthy();
    });

    it("does not show commit metadata when column is not done", () => {
      const { container } = render(
        <ChangesDiffModal
          {...defaultProps}
          column="in-progress"
          mergeDetails={MERGE_DETAILS}
        />,
      );

      expect(container.querySelector(".commit-diff-meta")).toBeNull();
    });

    it("does not show commit metadata when mergeDetails not provided", () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} column="done" />,
      );

      expect(container.querySelector(".commit-diff-meta")).toBeNull();
    });

    it("shows partial commit metadata (SHA only)", () => {
      render(
        <ChangesDiffModal
          {...defaultProps}
          column="done"
          mergeDetails={{ commitSha: "def4567890abcdef" }}
        />,
      );

      expect(screen.getByText("def4567")).toBeTruthy();
    });
  });

  describe("keyboard navigation", () => {
    it("navigates to next file with Ctrl+ArrowDown", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      expect(screen.getByText("1/3")).toBeTruthy();

      fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
      expect(screen.getByText("2/3")).toBeTruthy();
    });

    it("navigates to previous file with Ctrl+ArrowUp", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      // Go to second file first
      fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
      expect(screen.getByText("2/3")).toBeTruthy();

      // Go back
      fireEvent.keyDown(document, { key: "ArrowUp", ctrlKey: true });
      expect(screen.getByText("1/3")).toBeTruthy();
    });

    it("navigates with Cmd+ArrowDown (macOS)", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      fireEvent.keyDown(document, { key: "ArrowDown", metaKey: true });
      expect(screen.getByText("2/3")).toBeTruthy();
    });

    it("does not navigate on plain arrow keys", () => {
      render(<ChangesDiffModal {...defaultProps} />);

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(screen.getByText("1/3")).toBeTruthy();
    });
  });

  describe("empty state", () => {
    it("renders without errors with empty files array", () => {
      render(
        <ChangesDiffModal
          {...defaultProps}
          files={[]}
          stats={{ filesChanged: 0, additions: 0, deletions: 0 }}
        />,
      );

      expect(screen.getByText(/Changes — FN-001/)).toBeTruthy();
      // With empty files, the navigation section is not rendered at all
      // The "Select a file" placeholder should appear since no file is selected
      expect(screen.getByText("Select a file to view its diff")).toBeTruthy();
    });
  });

  describe("modal height constraint regression", () => {
    it("max-height uses calc() to stay within viewport padding", async () => {
      const { container } = render(
        <ChangesDiffModal {...defaultProps} />,
      );

      const modal = container.querySelector(".changes-diff-modal");
      expect(modal).toBeTruthy();

      // Load the stylesheet and verify the .changes-diff-modal rule contains
      // a calc()-based max-height that accounts for overlay padding.
      // This prevents the modal from extending past the viewport bottom.
      const css = loadAllAppCss();

      // Extract the .changes-diff-modal block (not the mobile override)
      // Match from ".changes-diff-modal {" to its closing "}"
      const blockMatch = css.match(
        /\.changes-diff-modal\s*\{[^}]*max-height:\s*([^;]+);/,
      );
      expect(blockMatch).toBeTruthy();
      const maxHeightValue = blockMatch![1].trim();

      // The max-height must use calc() against a viewport unit so the modal
      // never exceeds the visible viewport. The diff modal switched from a
      // padding-aware calc(100vh - 2 * --overlay-padding-top) to a fixed
      // calc(100dvh - 40px) inset when it became user-resizable, but the
      // intent — clamp to viewport — is unchanged.
      expect(maxHeightValue).toContain("calc(");
      expect(maxHeightValue).toMatch(/100(?:dvh|vh)/);
    });

    it("default and max constraints together do not exceed viewport", async () => {
      // Modal switched from a static `height: 80vh` to user-resizable, with
      // the initial size applied via :not([style*="height"]) selectors. Verify
      // both the default-height and the max-height clamp the modal within
      // the viewport.
      const css = loadAllAppCss();

      const defaultBlockMatch = css.match(
        /\.changes-diff-modal:not\(\[style\*="height"\]\)\s*\{([^}]*)\}/,
      );
      expect(defaultBlockMatch).toBeTruthy();
      const defaultBlock = defaultBlockMatch![1];
      const defaultHeightMatch = defaultBlock.match(/height:\s*([^;]+);/);
      expect(defaultHeightMatch).toBeTruthy();
      // The initial height uses min(...) against a viewport unit so it
      // never exceeds the visible viewport.
      expect(defaultHeightMatch![1].trim()).toContain("min(");
      expect(defaultHeightMatch![1].trim()).toMatch(/100(?:dvh|vh)/);

      const blockMatch = css.match(
        /\.changes-diff-modal\s*\{([^}]*)\}/,
      );
      expect(blockMatch).toBeTruthy();
      const block = blockMatch![1];
      const maxHeightMatch = block.match(/max-height:\s*([^;]+);/);
      expect(maxHeightMatch).toBeTruthy();
      expect(maxHeightMatch![1].trim()).toContain("calc(");
    });
  });
});
