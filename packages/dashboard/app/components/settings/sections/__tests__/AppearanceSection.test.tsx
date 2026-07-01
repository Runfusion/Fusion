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
    taskDetailChatFirst: false,
    ...formOverrides,
  } as SettingsFormState;
  const setForm = vi.fn((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => {
    form = typeof updater === "function" ? updater(form) : updater;
  });

  render(
    <AppearanceSection
      scopeBanner={<div data-testid="scope-banner" />}
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

  it("renders and updates the mobile task popup checkbox", () => {
    const { setForm, getForm } = renderAppearanceSection();

    const checkbox = screen.getByLabelText("Open mobile tasks as popups");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    expect(setForm).toHaveBeenCalledTimes(1);
    expect(getForm().openMobileTasksInPopup).toBe(true);
  });

  it("reflects a persisted enabled mobile task popup value", () => {
    renderAppearanceSection({ openMobileTasksInPopup: true });

    expect(screen.getByLabelText("Open mobile tasks as popups")).toBeChecked();
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
