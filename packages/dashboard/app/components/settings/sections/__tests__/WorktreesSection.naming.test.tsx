// @vitest-environment jsdom
/*
FNXC:WorkspaceWorktree 2026-08-24-06:11:
R14: the ticket-derived naming mode is only reachable if it renders in the existing
`worktreeNaming` control — a mode wired through core and the engine but absent from Settings is
unreachable for the operator who asked for it. Per the Surface Enumeration rule this asserts both
breakpoints, since the mobile media query is `(max-width: 768px), (max-height: 480px)` and the
control is inside a section that reflows there.
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { WorktreesSection, type WorktreesSectionProps } from "../WorktreesSection";
import type { SettingsFormState } from "../context";

function renderSection(form: Partial<SettingsFormState> = {}) {
  const setForm = vi.fn();
  const props = {
    form: { worktreeNaming: "random", ...form } as SettingsFormState,
    setForm,
    gitRemotes: [],
    worktrunkInstall: { status: null, loading: false, error: null } as unknown as WorktreesSectionProps["worktrunkInstall"],
    worktrunkInstallVerified: false,
    onOpenWorktreesDirPicker: vi.fn(),
    onWorktreeCopyFileChange: vi.fn(),
    onRemoveWorktreeCopyFile: vi.fn(),
    onAddWorktreeCopyFile: vi.fn(),
    onOpenWorktreeCopyFilePicker: vi.fn(),
  } satisfies WorktreesSectionProps;
  const view = render(<WorktreesSection {...props} />);
  return { setForm, view };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

describe("worktree naming style control", () => {
  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844], ["landscape phone", 844, 390]] as const) {
    it(`offers the branch/ticket mode alongside the existing modes at ${label}`, () => {
      setViewport(width, height);
      const { view } = renderSection();
      const select = within(view.container).getByLabelText(/worktree naming style/i) as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        "random",
        "task-id",
        "task-title",
        "branch",
      ]);
      expect(within(select).getByRole("option", { name: /branch \/ ticket/i })).toBeTruthy();
      view.unmount();
    });
  }

  it("writes the branch mode back to the settings form", () => {
    setViewport(1440, 900);
    const { setForm } = renderSection();
    fireEvent.change(screen.getByLabelText(/worktree naming style/i), { target: { value: "branch" } });
    expect(setForm).toHaveBeenCalled();
    const updater = setForm.mock.calls.at(-1)?.[0] as (f: SettingsFormState) => SettingsFormState;
    expect(updater({ worktreeNaming: "random" } as SettingsFormState).worktreeNaming).toBe("branch");
  });

  it("keeps the naming select enabled because recycle worktrees stayed deleted", () => {
    setViewport(1440, 900);
    const { view } = renderSection();
    const select = within(view.container).getByLabelText(/worktree naming style/i) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
  });
});
