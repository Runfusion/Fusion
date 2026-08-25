/**
 * RUFU-170: mobile header dropdowns must scroll internally, never overflow the viewport.
 *
 * FNXC:MobileProjectSwitchScroll 2026-08-24-20:07:
 * The mobile project switch (.mobile-project-switch-dropdown) and the mobile header overflow
 * menu (.mobile-overflow-menu) had no max-height/overflow-y/overscroll-behavior, so with 8+
 * projects (or menu items) the list grew past the viewport bottom and lower items were
 * unreachable. The fix caps both with the desktop selector's viewport-aware cap, repeated
 * with the dynamic-viewport unit (100dvh) so the cap tracks the VISIBLE mobile viewport
 * (100vh is the layout viewport and can exceed the visible area with expanded browser
 * chrome), with overflow-y: auto and overscroll-behavior: contain. This regression test
 * renders the real dropdowns with a long list and asserts the computed-style scroll cap
 * (red before the CSS fix, green after), and guards the desktop .project-selector-dropdown
 * cap as a regression check (Case C).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Header } from "../Header";
import type { ProjectInfo } from "../../api";
import { loadComponentCss, loadStylesCss } from "../../test/cssFixture";

const mockFetchScripts = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

/* FNXC:TestViewportMock 2026-08-24-20:07: mutable mode so one file covers the mobile
   repro (Cases A+B) and the desktop regression guard (Case C); keep the mocked surface
   complete — a missing export throws inside Header and the ErrorBoundary turns it into
   a missing element instead of a red assertion. */
const viewportMocks = vi.hoisted(() => ({ mode: "mobile" as string }));

vi.mock("../../hooks/useViewportMode", () => ({
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => viewportMocks.mode,
  isShortViewport: () => false,
}));

function makeProject(id: string, name: string): ProjectInfo {
  return {
    id,
    name,
    path: `/projects/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/* 12 projects: 3 bookmarked + 9 plain — comfortably past the ~8 items that overflow a
   phone viewport when the dropdown is uncapped. */
const projects: ProjectInfo[] = Array.from({ length: 12 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return makeProject(`project-${n}`, `Project ${n}`);
});

/**
 * Inject the real stylesheets (styles.css tokens + the two component files under test)
 * into <head> so window.getComputedStyle resolves the rules, following the
 * injectCommandCenterCss pattern (FN-6595). Removed and re-appended per case so each
 * case reads the CSS on disk at that moment.
 */
function injectRufuCss() {
  document.head.querySelector("style[data-testid='rufu-170-css']")?.remove();
  const style = document.createElement("style");
  style.setAttribute("data-testid", "rufu-170-css");
  style.textContent = [
    loadStylesCss(),
    loadComponentCss("ProjectSelector.css"),
    loadComponentCss("Header.css"),
  ].join("\n");
  document.head.appendChild(style);
}

/* FNXC:MobileProjectSwitchScroll 2026-08-25-18:44:
   Review P1: the mobile cap now resolves to the dvh restatement (last valid declaration
   wins); the desktop guard (Case C) keeps asserting the original vh cap, which is the
   pre-existing upstream declaration and intentionally unchanged. */
const MOBILE_CAP = "min(480px, calc(100dvh - 120px))";
const DESKTOP_CAP = "min(480px, calc(100vh - 120px))";

/**
 * The RUFU-170 invariant: the dropdown is viewport-capped and scrolls internally.
 * The cap literal matches the desktop selector's exact declarations (no parallel variant),
 * with the mobile cap additionally restated in dvh (see the CSS FNXC notes).
 */
function assertDropdownScrollCap(el: HTMLElement, expectedMaxHeight: string) {
  const style = window.getComputedStyle(el);
  expect(style.maxHeight).toBe(expectedMaxHeight);
  expect(style.overflowY).toBe("auto");
  expect(style.overscrollBehavior).toBe("contain");
}

describe("Header mobile dropdown scroll cap (RUFU-170)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchScripts.mockResolvedValue({});
    injectRufuCss();
  });

  it("Case A (symptom): the mobile project switch scrolls internally with a long list", () => {
    viewportMocks.mode = "mobile";
    localStorage.setItem(
      "fusion_project_bookmarks",
      JSON.stringify(projects.slice(0, 3).map((p) => p.id)),
    );

    const { container } = render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenGitHubImport={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("mobile-project-switch-trigger"));
    const dropdown = screen.getByTestId("mobile-project-switch-dropdown");
    // The cap must not silently collapse the panel: every project item still renders.
    expect(dropdown.querySelectorAll(".mobile-project-switch-item").length).toBe(12);
    assertDropdownScrollCap(dropdown, MOBILE_CAP);
  });

  it("Case B: the mobile header overflow menu scrolls internally with a long list", () => {
    viewportMocks.mode = "mobile";

    const { container } = render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenGitHubImport={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenUsage={vi.fn()}
        onOpenSchedules={vi.fn()}
        onOpenActivityLog={vi.fn()}
      />,
    );

    /* mobileNavEnabled is deliberately NOT passed: it must stay falsy so the
       compact overflow trigger/menu renders (hideFullNav = isMobile && mobileNavEnabled). */
    const trigger = container.querySelector("button.compact-overflow-trigger");
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);

    const menu = container.querySelector(".mobile-overflow-menu");
    expect(menu).not.toBeNull();
    assertDropdownScrollCap(menu as HTMLElement, MOBILE_CAP);
  });

  it("Case C (regression guard): the desktop project selector keeps its scroll cap", () => {
    viewportMocks.mode = "desktop";

    render(
      <Header
        projects={projects}
        currentProject={projects[0]}
        onSelectProject={vi.fn()}
        onViewAllProjects={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenGitHubImport={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    const dropdown = screen.getByTestId("project-selector-dropdown");
    assertDropdownScrollCap(dropdown, DESKTOP_CAP);
  });
});
