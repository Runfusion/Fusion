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
  const onShowCostBadgeOnCardsChange = vi.fn();
  const onTaskDetailDefaultTabChange = vi.fn();
  const onRightSidebarEnabledChange = vi.fn();
  let form: SettingsFormState = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: true,
    autoMerge: true,
    showCostBadgeOnCards: false,
    taskDetailDefaultTab: "activity",
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
      showCostBadgeOnCards={form.showCostBadgeOnCards}
      onShowCostBadgeOnCardsChange={onShowCostBadgeOnCardsChange}
      taskDetailDefaultTab={form.taskDetailDefaultTab}
      onTaskDetailDefaultTabChange={onTaskDetailDefaultTabChange}
      sessionBannersHidden={false}
      setSessionBannersHidden={vi.fn()}
    />,
  );

  return {
    setForm,
    getForm: () => form,
    onNavigationPlacementChange,
    onRightSidebarEnabledChange,
    onShowCostBadgeOnCardsChange,
    onTaskDetailDefaultTabChange,
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

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442 deleted the two board task-open routing settings: the floating task window is now the unconditional route, so
  Appearance must expose neither control — no row, no label, no help copy, and no leftover click target — while its
  neighbouring rows stay intact. The cases that drove those two toggles are removed with their subject.
  */
  it("exposes no board task-open routing controls or leftover shells", () => {
    renderAppearanceSection();

    expect(screen.queryByLabelText("Open tasks in the right sidebar")).toBeNull();
    expect(screen.queryByLabelText("Open tasks as popups")).toBeNull();
    expect(screen.queryByLabelText("Open task details with Chat first")).toBeNull();
    expect(screen.queryByText(/board task cards open detail in the right sidebar/)).toBeNull();
    expect(screen.queryByText(/open the existing movable task popup/)).toBeNull();
    for (const key of ["openTasksInRightSidebar", "openMobileTasksInPopup", "taskDetailChatFirst"]) {
      expect(document.querySelector(`[data-setting-key="${key}"]`)).toBeNull();
    }
    for (const checkbox of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
      const labelled = checkbox.labels?.length || checkbox.getAttribute("aria-label");
      expect(labelled).toBeTruthy();
    }
    expect(screen.getByLabelText("Show cost badges on task cards")).toBeInTheDocument();
    expect(screen.getByLabelText("Open task details on")).toBeInTheDocument();
  });

  it("mirrors every mounted Appearance control to its matching live callback", () => {
    const callbacks = renderAppearanceSection();

    fireEvent.click(screen.getByLabelText("Show cost badges on task cards"));
    fireEvent.change(screen.getByLabelText("Open task details on"), { target: { value: "chat" } });

    expect(callbacks.onShowCostBadgeOnCardsChange).toHaveBeenCalledWith(true);
    expect(callbacks.onTaskDetailDefaultTabChange).toHaveBeenCalledWith("chat");
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

  /*
  FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
  FN-442 replaced the Chat-first checkbox with a three-value selector. It must offer exactly Definition, Chat, and
  Activity, default to Activity, write the chosen value into the settings form, and mirror it to the live callback.
  */
  it("renders the task detail default tab selector with its three choices and Activity default", () => {
    renderAppearanceSection();

    const select = screen.getByLabelText("Open task details on") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["definition", "chat", "activity"]);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Definition", "Chat", "Activity"]);
    expect(select.value).toBe("activity");
    expect(screen.getByText(/Choose which tab a task opens on and leads the task detail tab bar/)).toBeInTheDocument();
  });

  it.each(["definition", "chat", "activity"] as const)("writes the %s task detail default tab to the form and live callback", (value) => {
    const { setForm, getForm, onTaskDetailDefaultTabChange } = renderAppearanceSection();

    fireEvent.change(screen.getByLabelText("Open task details on"), { target: { value } });

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().taskDetailDefaultTab).toBe(value);
    expect(onTaskDetailDefaultTabChange).toHaveBeenCalledWith(value);
  });

  it("reflects a persisted task detail default tab value", () => {
    renderAppearanceSection({ taskDetailDefaultTab: "chat" });

    expect((screen.getByLabelText("Open task details on") as HTMLSelectElement).value).toBe("chat");
  });
});
