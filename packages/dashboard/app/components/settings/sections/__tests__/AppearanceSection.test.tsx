import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { AppearanceSection } from "../AppearanceSection";
import type { SettingsFormState } from "../context";

vi.mock("../../ThemeSelector", () => ({
  ThemeSelector: () => <div data-testid="theme-selector" />,
}));

vi.mock("../../LanguageSelector", () => ({
  LanguageSelector: () => <div data-testid="language-selector" />,
}));

function renderAppearanceSection(formOverrides: Partial<Settings> = {}) {
  let form: SettingsFormState = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: true,
    autoMerge: true,
    openTasksInRightSidebar: false,
    openMobileTasksInPopup: false,
    taskPopupsBoardListOnly: true,
    showCostBadgeOnCards: false,
    taskDetailChatFirst: false,
    ...formOverrides,
  } as SettingsFormState;
  const setForm = vi.fn((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => {
    form = typeof updater === "function" ? updater(form) : updater;
  });

  render(
    <AppearanceSection
      form={form}
      setForm={setForm}
      themeMode="dark"
      colorTheme="ocean"
      dashboardFontScalePct={100}
      sessionBannersHidden={false}
      setSessionBannersHidden={vi.fn()}
    />,
  );

  return { setForm, getForm: () => form };
}

describe("AppearanceSection", () => {
  it("renders and updates the open-tasks-in-right-sidebar checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Open tasks in the right sidebar");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().openTasksInRightSidebar).toBe(true);
  });

  it("reflects a persisted enabled value", () => {
    renderAppearanceSection({ openTasksInRightSidebar: true });

    expect(screen.getByLabelText("Open tasks in the right sidebar")).toBeChecked();
  });

  it("renders and updates the task popup checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Open tasks as popups");
    expect(checkbox).not.toBeChecked();
    /*
    FNXC:MobileTaskPopups 2026-07-15-17:35:
    This assertion tracked copy that FN-7945 deliberately rewrote — the setting became all-viewport, so the help text gained "List row/card" and the popup became "movable" — and it had been failing against the shipped string ever since.
    Realigned to the copy the section actually renders rather than deleted: the requirement (the help text must state which click targets route to the popup) is still worth asserting, and dropping it would leave the copy uncovered.
    */
    expect(screen.getByText(/ordinary board task-card, List row\/card, and right-dock Tasks-list clicks open the existing movable task popup/)).toBeInTheDocument();
    expect(screen.getByText(/Deep-tab and other task opens keep their current behavior/)).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().openMobileTasksInPopup).toBe(true);
  });

  it("reflects a persisted enabled task popup value", () => {
    renderAppearanceSection({ openMobileTasksInPopup: true });

    expect(screen.getByLabelText("Open tasks as popups")).toBeChecked();
  });

  it("renders and updates the task popup view attachment checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Keep task popups on the view where they were opened");
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/appears only on the view where it was opened/)).toBeInTheDocument();
    expect(screen.getByText(/returning restores it in the same position\. Default: enabled/)).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().taskPopupsBoardListOnly).toBe(false);
  });

  it("reflects the default enabled task popup view scoping value", () => {
    renderAppearanceSection({ taskPopupsBoardListOnly: true });

    expect(screen.getByLabelText("Keep task popups on the view where they were opened")).toBeChecked();
  });

  it("renders and updates the cost badge checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Show cost badges on task cards");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/board cards show derived model cost next to execution time/)).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().showCostBadgeOnCards).toBe(true);
  });

  it("reflects a persisted enabled cost badge value", () => {
    renderAppearanceSection({ showCostBadgeOnCards: true });

    expect(screen.getByLabelText("Show cost badges on task cards")).toBeChecked();
  });

  it("renders task detail Chat-first as unchecked by default and updates it", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Open task details with Chat first");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/Off by default: task details list Activity first/)).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().taskDetailChatFirst).toBe(true);
  });

  it("reflects a persisted enabled task detail Chat-first value", () => {
    renderAppearanceSection({ taskDetailChatFirst: true });

    expect(screen.getByLabelText("Open task details with Chat first")).toBeChecked();
  });
});
