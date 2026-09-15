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

function renderAppearanceSection(
  formOverrides: Partial<Settings> = {},
  onChatMessageLayoutChange = vi.fn(),
  onNavigationPlacementChange = vi.fn(),
) {
  const onOpenTasksInRightSidebarChange = vi.fn();
  const onOpenMobileTasksInPopupChange = vi.fn();
  const onShowCostBadgeOnCardsChange = vi.fn();
  const onTaskDetailChatFirstChange = vi.fn();
  const onRightSidebarEnabledChange = vi.fn();
  let form: SettingsFormState = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: true,
    autoMerge: true,
    openTasksInRightSidebar: false,
    openMobileTasksInPopup: false,
    showCostBadgeOnCards: false,
    taskDetailChatFirst: false,
    chatMessageLayout: "bubbles",
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
      chatMessageLayout={form.chatMessageLayout}
      onChatMessageLayoutChange={onChatMessageLayoutChange}
      navigationPlacement={form.navigationPlacement}
      onNavigationPlacementChange={onNavigationPlacementChange}
      rightSidebarEnabled={form.rightSidebarEnabled}
      onRightSidebarEnabledChange={onRightSidebarEnabledChange}
      openTasksInRightSidebar={form.openTasksInRightSidebar}
      onOpenTasksInRightSidebarChange={onOpenTasksInRightSidebarChange}
      openMobileTasksInPopup={form.openMobileTasksInPopup}
      onOpenMobileTasksInPopupChange={onOpenMobileTasksInPopupChange}
      showCostBadgeOnCards={form.showCostBadgeOnCards}
      onShowCostBadgeOnCardsChange={onShowCostBadgeOnCardsChange}
      taskDetailChatFirst={form.taskDetailChatFirst}
      onTaskDetailChatFirstChange={onTaskDetailChatFirstChange}
      sessionBannersHidden={false}
      setSessionBannersHidden={vi.fn()}
    />,
  );

  return {
    setForm,
    getForm: () => form,
    onNavigationPlacementChange,
    onRightSidebarEnabledChange,
    onOpenTasksInRightSidebarChange,
    onOpenMobileTasksInPopupChange,
    onShowCostBadgeOnCardsChange,
    onTaskDetailChatFirstChange,
  };
}

describe("AppearanceSection", () => {
  /*
   * FN-419: the navigation placement control is the only in-product way to move the primary menu, so it must render
   * the current value, write both the form and the live callback, and fail closed on a malformed persisted value.
   */
  it("renders the two-option navigation placement selector and updates to the sidebar", () => {
    const onNavigationPlacementChange = vi.fn();
    const { setForm, getForm } = renderAppearanceSection({}, vi.fn(), onNavigationPlacementChange);
    const selector = screen.getByLabelText("Navigation menu placement") as HTMLSelectElement;
    expect(selector.value).toBe("footer");
    expect(Array.from(selector.options).map((option) => option.value)).toEqual(["footer", "sidebar"]);
    fireEvent.change(selector, { target: { value: "sidebar" } });
    expect(onNavigationPlacementChange).toHaveBeenCalledWith("sidebar");
    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().navigationPlacement).toBe("sidebar");
  });

  it("selects a persisted sidebar navigation placement", () => {
    renderAppearanceSection({ navigationPlacement: "sidebar" });
    expect((screen.getByLabelText("Navigation menu placement") as HTMLSelectElement).value).toBe("sidebar");
  });

  it("displays an invalid persisted navigation placement as the bottom-bar default", () => {
    renderAppearanceSection({ navigationPlacement: "left" as never });
    expect((screen.getByLabelText("Navigation menu placement") as HTMLSelectElement).value).toBe("footer");
  });

  /*
   * FN-426: the right tool dock is optional and default-off, so this toggle is the only in-product way to bring it
   * back. It must render unchecked for absent/invalid persisted values and write both the form and the live callback.
   */
  it("renders the right tool sidebar opt-in unchecked by default and enables it", () => {
    const { setForm, getForm, onRightSidebarEnabledChange } = renderAppearanceSection();
    const toggle = screen.getByLabelText("Show the right tool sidebar") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onRightSidebarEnabledChange).toHaveBeenCalledWith(true);
    expect(getForm().rightSidebarEnabled).toBe(true);
    expect(setForm).toHaveBeenCalledTimes(1);
  });

  it("checks the right tool sidebar opt-in for a persisted true", () => {
    renderAppearanceSection({ rightSidebarEnabled: true });
    expect((screen.getByLabelText("Show the right tool sidebar") as HTMLInputElement).checked).toBe(true);
  });

  it("treats a malformed persisted right sidebar value as disabled", () => {
    renderAppearanceSection({ rightSidebarEnabled: "yes" as never });
    expect((screen.getByLabelText("Show the right tool sidebar") as HTMLInputElement).checked).toBe(false);
  });

  it("renders the two-option conversation layout selector and updates full width", () => {
    const onChatMessageLayoutChange = vi.fn();
    const { setForm, getForm } = renderAppearanceSection({}, onChatMessageLayoutChange);
    const selector = screen.getByLabelText("Conversation layout") as HTMLSelectElement;
    expect(selector.value).toBe("bubbles");
    // Scoped to this selector: FN-419 added a second select row to the section.
    expect(Array.from(selector.options).map((option) => option.value)).toEqual(["bubbles", "full-width"]);
    fireEvent.change(selector, { target: { value: "full-width" } });
    expect(onChatMessageLayoutChange).toHaveBeenCalledWith("full-width");
    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().chatMessageLayout).toBe("full-width");
  });

  it("selects a persisted full-width conversation layout", () => {
    renderAppearanceSection({ chatMessageLayout: "full-width" });
    expect((screen.getByLabelText("Conversation layout") as HTMLSelectElement).value).toBe("full-width");
  });

  it("renders and updates the open-tasks-in-right-sidebar checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Open tasks in the right sidebar");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().openTasksInRightSidebar).toBe(true);
  });

  it("mirrors every mounted Appearance toggle to its matching live callback", () => {
    const callbacks = renderAppearanceSection();

    fireEvent.click(screen.getByLabelText("Open tasks in the right sidebar"));
    fireEvent.click(screen.getByLabelText("Open tasks as popups"));
    fireEvent.click(screen.getByLabelText("Show cost badges on task cards"));
    fireEvent.click(screen.getByLabelText("Open task details with Chat first"));

    expect(callbacks.onOpenTasksInRightSidebarChange).toHaveBeenCalledWith(true);
    expect(callbacks.onOpenMobileTasksInPopupChange).toHaveBeenCalledWith(true);
    expect(callbacks.onShowCostBadgeOnCardsChange).toHaveBeenCalledWith(true);
    expect(callbacks.onTaskDetailChatFirstChange).toHaveBeenCalledWith(true);
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
    Help text must state which click targets route to the popup.

    FNXC:DashboardTests 2026-09-12-01:35:
    Popup help names the remaining Board and List task-open surfaces after the duplicate dock task list was removed.
    */
    expect(
      screen.getByText(
        /board task-card clicks including Changes, Retries, and Workflow chips, plus ordinary List row\/card clicks, open the existing movable task popup/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Other task opens keep their current behavior/)).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().openMobileTasksInPopup).toBe(true);
  });

  it("reflects a persisted enabled task popup value", () => {
    renderAppearanceSection({ openMobileTasksInPopup: true });

    expect(screen.getByLabelText("Open tasks as popups")).toBeChecked();
  });

  /*
  FNXC:TaskWindowIdentity 2026-09-14-17:46:
  FN-392: task windows are permanently project-scoped, so Appearance exposes no per-view scoping control — no row, no
  label, no help copy, and no leftover click target — while its neighbouring toggles stay intact.
  */
  it("exposes no task popup view scoping control or leftover shell", () => {
    renderAppearanceSection();

    expect(screen.queryByLabelText("Keep task popups on the view where they were opened")).toBeNull();
    expect(screen.queryByText(/appears only on the view where it was opened/)).toBeNull();
    expect(screen.queryByText(/returning restores it in the same position/)).toBeNull();
    expect(document.querySelector('[data-setting-key="taskPopupsBoardListOnly"]')).toBeNull();
    expect(screen.getByLabelText("Open tasks as popups")).toBeInTheDocument();
    expect(screen.getByLabelText("Show cost badges on task cards")).toBeInTheDocument();
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
