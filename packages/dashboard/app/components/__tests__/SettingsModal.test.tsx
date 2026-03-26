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
    expect(screen.getAllByText("General").length).toBeGreaterThanOrEqual(1);
    const nav = screen.getAllByText("Scheduling");
    expect(nav.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Worktrees").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Commands").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Merge").length).toBeGreaterThanOrEqual(1);
  });

  it("shows General fields by default", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();
    // Fields from other sections should not be visible
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
    expect(screen.queryByLabelText("Max Worktrees")).toBeNull();
  });

  it("switches section when clicking sidebar item", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // Click Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
    expect(screen.getByLabelText("Max Concurrent Tasks")).toBeTruthy();
    expect(screen.queryByLabelText("Task Prefix")).toBeNull();

    // Click Commands
    fireEvent.click(screen.getByText("Commands"));
    expect(screen.getByLabelText("Test Command")).toBeTruthy();
    expect(screen.getByLabelText("Build Command")).toBeTruthy();
    expect(screen.queryByLabelText("Max Concurrent Tasks")).toBeNull();
  });

  it("all settings fields are present across all sections", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    // General (default)
    expect(screen.getByLabelText("Task Prefix")).toBeTruthy();

    // Scheduling
    fireEvent.click(screen.getByText("Scheduling"));
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

  it("Task Prefix field saves correctly when set", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "PROJ" } });
    expect(input.value).toBe("PROJ");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskPrefix).toBe("PROJ");
  });

  it("Task Prefix field submits undefined when empty (uses default)", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));

    const payload = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.taskPrefix).toBeUndefined();
  });

  it("Task Prefix shows validation error for invalid input", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    expect(screen.getByText("Prefix must be 1–10 uppercase letters")).toBeTruthy();
  });

  it("Task Prefix validation error prevents save", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    const input = screen.getByLabelText("Task Prefix") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bad" } });

    fireEvent.click(screen.getByText("Save"));
    // Should not have called updateSettings due to validation error
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("groupOverlappingFiles input has type checkbox", async () => {
    render(<SettingsModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Scheduling"));
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
