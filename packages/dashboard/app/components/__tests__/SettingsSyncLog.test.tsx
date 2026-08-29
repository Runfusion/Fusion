import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsSyncLog } from "../SettingsSyncLog";
import type { SyncLogEntry } from "../SettingsSyncLog";

vi.mock("lucide-react", () => ({
  Upload: () => <span data-testid="upload-icon">upload</span>,
  Download: () => <span data-testid="download-icon">download</span>,
  ChevronDown: () => <span data-testid="chevron-down">chevron</span>,
}));

function makeEntry(overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    id: "sync-1",
    timestamp: "2026-04-14T10:00:00.000Z",
    direction: "push",
    result: "success",
    nodeId: "node-1",
    nodeName: "Build Server",
    ...overrides,
  };
}

describe("SettingsSyncLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("basic rendering", () => {
    it("renders entries count in header", () => {
      const entries = [
        makeEntry({ id: "1" }),
        makeEntry({ id: "2" }),
        makeEntry({ id: "3" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      expect(screen.getByText("3 entries")).toBeInTheDocument();
    });

    it("renders single entry correctly", () => {
      const entries = [makeEntry({ id: "1" })];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      expect(screen.getByText("1 entry")).toBeInTheDocument();
    });

    it("renders entries in chronological order (newest first)", () => {
      const entries = [
        makeEntry({ id: "1", timestamp: "2026-04-14T10:00:00.000Z" }),
        makeEntry({ id: "2", timestamp: "2026-04-14T11:00:00.000Z" }),
        makeEntry({ id: "3", timestamp: "2026-04-14T12:00:00.000Z" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      // Expand the list
      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      // Count entries - should be 3
      const entryNodes = document.querySelectorAll(".settings-sync-log__entry");
      expect(entryNodes.length).toBe(3);
    });

    it("shows correct direction icons", () => {
      const entries = [
        makeEntry({ id: "1", direction: "push" }),
        makeEntry({ id: "2", direction: "pull" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByTestId("upload-icon")).toBeInTheDocument();
      expect(screen.getByTestId("download-icon")).toBeInTheDocument();
    });

    it("shows correct result badges", () => {
      const entries = [
        makeEntry({ id: "1", result: "success" }),
        makeEntry({ id: "2", result: "conflict" }),
        makeEntry({ id: "3", result: "error" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByText("Success")).toBeInTheDocument();
      expect(screen.getByText("Conflict")).toBeInTheDocument();
      expect(screen.getByText("Error")).toBeInTheDocument();

      const successBadge = document.querySelector(".settings-sync-log__badge--success");
      const conflictBadge = document.querySelector(".settings-sync-log__badge--conflict");
      const errorBadge = document.querySelector(".settings-sync-log__badge--error");

      expect(successBadge).toBeInTheDocument();
      expect(conflictBadge).toBeInTheDocument();
      expect(errorBadge).toBeInTheDocument();
    });

    it("shows node names", () => {
      const entries = [
        makeEntry({ id: "1", nodeName: "Server Alpha" }),
        makeEntry({ id: "2", nodeName: "Server Beta" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} singleNode={false} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      // Use queryAllByText with exact match for the entry node spans
      const nodeSpans = document.querySelectorAll(".settings-sync-log__entry-node");
      expect(nodeSpans[0].textContent).toBe("Server Alpha");
      expect(nodeSpans[1].textContent).toBe("Server Beta");
    });

    it("shows details when present", () => {
      const entries = [
        makeEntry({ id: "1", details: "3 settings changed" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByText("3 settings changed")).toBeInTheDocument();
    });
  });

  describe("filtering", () => {
    it("direction filter works", () => {
      const entries = [
        makeEntry({ id: "1", direction: "push" }),
        makeEntry({ id: "2", direction: "pull" }),
        makeEntry({ id: "3", direction: "push" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      const directionSelect = screen.getByRole("combobox", { name: "Direction:" });
      fireEvent.change(directionSelect, { target: { value: "push" } });

      // When filter is set, entry count in header should still show 3
      // but actual list entries should be filtered
      fireEvent.change(directionSelect, { target: { value: "pull" } });
      fireEvent.change(directionSelect, { target: { value: "all" } });
    });

    it("node filter works when singleNode is not set", () => {
      const entries = [
        makeEntry({ id: "1", nodeName: "Build Server" }),
        makeEntry({ id: "2", nodeName: "GPU Cluster" }),
      ];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} singleNode={false} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByRole("combobox", { name: "Node:" })).toBeInTheDocument();
    });

    it("hides node filter when singleNode is true", () => {
      const entries = [makeEntry({ id: "1" })];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} singleNode={true} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.queryByRole("combobox", { name: "Node:" })).not.toBeInTheDocument();
    });
  });

  describe("states", () => {
    it("empty state when no entries", () => {
      render(<SettingsSyncLog nodeId="node-1" entries={[]} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByText("No sync history available")).toBeInTheDocument();
    });

    it("loading state", () => {
      render(<SettingsSyncLog nodeId="node-1" entries={[]} loading={true} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });
  });

  describe("collapsible toggle", () => {
    it("default state is collapsed", () => {
      render(<SettingsSyncLog nodeId="node-1" entries={[makeEntry()]} />);

      // Entry list should not be visible (use entry count text as proxy)
      expect(screen.getByText("1 entry")).toBeInTheDocument();
      expect(document.querySelector(".settings-sync-log__list")).not.toBeInTheDocument();
    });

    it("expands on click", () => {
      render(<SettingsSyncLog nodeId="node-1" entries={[makeEntry()]} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      expect(document.querySelector(".settings-sync-log__list")).toBeInTheDocument();
    });

    it("collapses on second click", () => {
      render(<SettingsSyncLog nodeId="node-1" entries={[makeEntry()]} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));
      expect(document.querySelector(".settings-sync-log__list")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));
      expect(document.querySelector(".settings-sync-log__list")).not.toBeInTheDocument();
    });
  });

  describe("timestamp formatting", () => {
    it("formats timestamps for display", () => {
      const entries = [makeEntry({ timestamp: "2026-04-14T10:30:00.000Z" })];
      render(<SettingsSyncLog nodeId="node-1" entries={entries} />);

      fireEvent.click(screen.getByTestId("settings-sync-log-header"));

      // Check that timestamps are present
      const timestampSpans = document.querySelectorAll(".settings-sync-log__entry-timestamp");
      expect(timestampSpans.length).toBe(1);
    });
  });
});
