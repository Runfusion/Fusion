import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsSyncConflictModal } from "../SettingsSyncConflictModal";

// Define the props type inline to avoid import issues
interface TestConflictEntry {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

interface TestProps {
  isOpen: boolean;
  onClose: () => void;
  onResolve: (resolutions: Array<{ key: string; value: unknown }>) => Promise<void>;
  conflicts: TestConflictEntry[];
  localNodeName: string;
  remoteNodeName: string;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

function makeProps(overrides: Partial<TestProps> = {}): TestProps {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onResolve: vi.fn().mockResolvedValue(undefined),
    conflicts: [
      { key: "maxConcurrent", localValue: 2, remoteValue: 4 },
      { key: "defaultModelId", localValue: "claude-sonnet", remoteValue: "gpt-4o" },
    ],
    localNodeName: "Local Node",
    remoteNodeName: "Remote Node",
    addToast: vi.fn(),
    ...overrides,
  };
}

describe("SettingsSyncConflictModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic rendering", () => {
    it("renders nothing when isOpen is false", () => {
      render(<SettingsSyncConflictModal {...makeProps({ isOpen: false })} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders nothing when conflicts array is empty", () => {
      render(<SettingsSyncConflictModal {...makeProps({ conflicts: [] })} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders all conflicts with key names", () => {
      const conflicts = [
        { key: "setting1", localValue: 1, remoteValue: 2 },
        { key: "setting2", localValue: "a", remoteValue: "b" },
        { key: "setting3", localValue: true, remoteValue: false },
      ];
      render(<SettingsSyncConflictModal {...makeProps({ conflicts })} />);

      expect(screen.getByText("setting1")).toBeInTheDocument();
      expect(screen.getByText("setting2")).toBeInTheDocument();
      expect(screen.getByText("setting3")).toBeInTheDocument();
    });

    it("shows side-by-side diff panels", () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      // There are multiple "Local Node" and "Remote Node" labels (one per conflict)
      const localLabels = document.querySelectorAll(".settings-sync-conflict-modal__diff-label");
      expect(localLabels.length).toBeGreaterThan(0);
    });

    it("default resolution is Keep Local", () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      const keepLocalRadios = screen.getAllByRole("radio", { name: "Keep Local" });
      expect(keepLocalRadios.length).toBeGreaterThan(0);
      expect(keepLocalRadios[0]).toBeChecked();
    });
  });

  describe("resolution interactions", () => {
    it("selecting Keep Remote updates resolution", async () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      const keepRemoteRadios = screen.getAllByRole("radio", { name: "Keep Remote" });
      fireEvent.click(keepRemoteRadios[0]);
      expect(keepRemoteRadios[0]).toBeChecked();
    });

    it("Merge Manually shows textarea", async () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      const mergeManuallyRadios = screen.getAllByRole("radio", { name: "Merge Manually" });
      fireEvent.click(mergeManuallyRadios[0]);

      const textareas = screen.getAllByRole("textbox");
      expect(textareas.length).toBeGreaterThan(0);
    });

    it("Resolve All: Keep Local sets all to local", () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      fireEvent.click(screen.getByText("Resolve All: Keep Local"));

      const keepLocalRadios = screen.getAllByRole("radio", { name: "Keep Local" });
      for (const radio of keepLocalRadios) {
        expect(radio).toBeChecked();
      }
    });

    it("Resolve All: Keep Remote sets all to remote", () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      fireEvent.click(screen.getByText("Resolve All: Keep Remote"));

      const keepRemoteRadios = screen.getAllByRole("radio", { name: "Keep Remote" });
      for (const radio of keepRemoteRadios) {
        expect(radio).toBeChecked();
      }
    });
  });

  describe("confirm/cancel actions", () => {
    it("Confirm calls onResolve with correct payload", async () => {
      const onResolve = vi.fn().mockResolvedValue(undefined);
      render(<SettingsSyncConflictModal {...makeProps({ onResolve })} />);

      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledTimes(1);
        const resolutions = onResolve.mock.calls[0][0];
        expect(resolutions).toHaveLength(2);
        expect(resolutions[0]).toEqual({ key: "maxConcurrent", value: 2 });
        expect(resolutions[1]).toEqual({ key: "defaultModelId", value: "claude-sonnet" });
      });
    });

    it("Cancel calls onClose", () => {
      const onClose = vi.fn();
      render(<SettingsSyncConflictModal {...makeProps({ onClose })} />);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Confirm shows loading state", async () => {
      let resolvePromise: () => void;
      const onResolve = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolvePromise = resolve; })
      );
      render(<SettingsSyncConflictModal {...makeProps({ onResolve })} />);

      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      expect(screen.getByText("Resolving...")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Resolving..." })).toBeDisabled();

      resolvePromise!();
    });

    it("Error during resolution shows error toast", async () => {
      const addToast = vi.fn();
      const onResolve = vi.fn().mockRejectedValue(new Error("Sync failed"));
      render(<SettingsSyncConflictModal {...makeProps({ addToast, onResolve })} />);

      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Sync failed", "error");
      });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("diff rendering", () => {
    it("diff content rendered in pre tags", () => {
      render(<SettingsSyncConflictModal {...makeProps()} />);
      const diffContents = document.querySelectorAll(".settings-sync-conflict-modal__diff-content pre");
      expect(diffContents.length).toBeGreaterThan(0);
    });
  });
});
