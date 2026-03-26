import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsModal } from "../SettingsModal";
import type { Settings } from "@hai/core";

const defaultSettings: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  groupOverlappingFiles: false,
  autoMerge: false,
  recycleWorktrees: false,
  worktreeInitCommand: "",
  testCommand: "",
  buildCommand: "",
};

vi.mock("../../api", () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
  updateSettings: vi.fn(() => Promise.resolve({ ...defaultSettings })),
}));

import { fetchSettings, updateSettings } from "../../api";

const onClose = vi.fn();
const addToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsModal", () => {
  it("renders all sidebar section labels", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Each label appears in the sidebar nav
    const nav = screen.getAllByText("Scheduling");
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Worktrees").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Commands").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Merge").length).toBeGreaterThanOrEqual(1);
  });

  it("shows Scheduling fields by default", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.getByLabelText("Poll Interval (ms)")).toBeTruthy();
    // Fields from other sections should not be visible
    expect(screen.queryByLabelText("Max Worktrees")).toBeNull();
    expect(screen.queryByLabelText("Test Command")).toBeNull();
  });

  it("switches section when clicking sidebar item", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
  });

  it("all settings fields are present across all sections", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Scheduling (default)
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.getByLabelText("Poll Interval (ms)")).toBeTruthy();

    // Worktrees
    fireEvent.click(screen.getByText("Worktrees"));
    expect(screen.getByLabelText("Max Worktrees")).toBeTruthy();
    expect(screen.getByLabelText("Worktree Init Command")).toBeTruthy();
    expect(screen.getByText("Recycle worktrees")).toBeTruthy();

    // Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();

    // Merge
    fireEvent.click(screen.getByText("Merge"));
    expect(screen.getByText("Auto-merge completed tasks")).toBeTruthy();
  });

  it("shows Recycle worktrees checkbox in Worktrees section", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Worktrees"));
    const checkbox = screen.getByLabelText("Recycle worktrees");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("toggling recycleWorktrees checkbox sends true in save payload", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Worktrees"));
    const checkbox = screen.getByLabelText("Recycle worktrees");
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.recycleWorktrees).toBe(true);
  });

  it("groupOverlappingFiles input has type checkbox", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const checkbox = screen.getByLabelText("Serialize tasks with overlapping files");
    expect(checkbox).toBeTruthy();
    expect(checkbox.getAttribute("type")).toBe("checkbox");
  });

  it("save button calls updateSettings with form data", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.maxConcurrent).toBe(2);
    expect(payload.pollIntervalMs).toBe(15000);
  });
});
