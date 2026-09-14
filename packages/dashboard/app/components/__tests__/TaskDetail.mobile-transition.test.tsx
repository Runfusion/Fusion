/**
 * Focused regression coverage for the FN-7587 mobile task-detail predictive-back
 * slide/fade transition polish.
 *
 * FNXC:TaskDetailSwipeBack 2026-07-05-12:45:
 * This suite asserts ONLY the presentation-layer invariant this task adds:
 *  - the mobile transition class is applied to the modal/list/nested surface when the
 *    viewport is mobile;
 *  - the class is absent on desktop, and does not linger after re-rendering desktop-width;
 *  - the CSS neutralizes the animation under `prefers-reduced-motion: reduce`
 *    (jsdom cannot execute CSS keyframe animations, so this is asserted statically
 *    against the stylesheet source, mirroring the project's existing
 *    `TaskDetailModal.css.test.ts` / `TaskDetailModal.github-tracking-enable.css.test.ts`
 *    pattern of asserting CSS text rather than computed animation state).
 *
 * Board main-panel gating (MainContent.tsx) is covered separately in
 * `TaskDetail.mobile-transition.board-panel.test.tsx` because that surface requires the
 * full App-level mock harness (Board/ListView/TaskDetailModal module mocks + real
 * lucide-react icons via Header), which conflicts with this file's TaskDetailModal-focused
 * `test-helpers` harness (fixed lucide-react icon allowlist) if combined in one module.
 *
 * This suite deliberately does NOT re-derive dismissal-routing coverage — that remains the
 * sole responsibility of `TaskDetail.swipe-back.test.tsx` and `navigation-history.test.tsx`,
 * which this task runs unmodified (see PROMPT.md Step 0/3) to prove the animation layer does
 * not perturb the `useNavigationHistory` / `popstate` / `fusion:native-back` invariant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import {
  makeTask,
  noop,
  noopMove,
  noopDelete,
  noopMerge,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";

const MOBILE_WIDTH = 375;
const DESKTOP_WIDTH = 1024;
const LANDSCAPE_PHONE_WIDTH = 844;
const LANDSCAPE_PHONE_HEIGHT = 390;
const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");
const originalInnerHeight = window.innerHeight;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

function installLandscapePhoneViewport(): void {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: LANDSCAPE_PHONE_WIDTH });
  Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: LANDSCAPE_PHONE_HEIGHT });
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: { width: LANDSCAPE_PHONE_WIDTH, height: LANDSCAPE_PHONE_HEIGHT },
  });
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches:
      query === "(max-width: 768px), (max-height: 480px)" ||
      query === "(max-height: 480px)" ||
      query === "(min-width: 769px) and (max-width: 1024px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
}

describe("Task-detail mobile predictive-back transition — CSS invariants", () => {
  it("fait monter le panneau Board depuis le bas et neutralise le mouvement réduit", () => {
    const css = readAppFile("styles.css");
    expect(css).toMatch(/html\[data-viewport-mode="mobile"\] \.task-detail-main-panel--mobile-transition\s*\{[^}]*animation: alpha-mobile-drawer-rise-in/);
    expect(css).toMatch(/@keyframes alpha-mobile-drawer-rise-in\s*\{[\s\S]*?from\s*\{[^}]*translate: 0 var\(--space-xl\)/);
    expect(css).not.toMatch(/@keyframes alpha-mobile-drawer-rise-in\s*\{[\s\S]*?translateX/);
    const reducedMotionBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  html[data-viewport-mode=\"mobile\"] .task-detail-main-panel--mobile-transition"));
    expect(reducedMotionBlock.slice(0, 250)).toContain("animation: none;");
  });

  it("fait monter les surfaces modales depuis le bas et neutralise le mouvement réduit", () => {
    const css = readAppFile("components/TaskDetailModal.css");
    expect(css).toMatch(/html\[data-viewport-mode="mobile"\] \.task-detail-modal--mobile-transition\s*\{[^}]*animation: alpha-mobile-drawer-rise-in/);
    expect(css).not.toContain("task-detail-modal-mobile-slide-fade-in");
    const reducedMotionBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  html[data-viewport-mode=\"mobile\"] .task-detail-modal--mobile-transition"));
    expect(reducedMotionBlock.slice(0, 250)).toContain("animation: none;");
  });
});

describe("TaskDetailModal wrapper — mobile transition class gating (modal/list/nested surface)", () => {
  setupTaskDetailModalHooks();

  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setViewportWidth(DESKTOP_WIDTH);
    Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: originalInnerHeight });
    if (originalScreenDescriptor) Object.defineProperty(window, "screen", originalScreenDescriptor);
    delete document.documentElement.dataset.viewportMode;
  });

  it("applies the mobile transition class to the modal surface when the viewport is mobile", async () => {
    setViewportWidth(MOBILE_WIDTH);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-300" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".task-detail-modal--mobile-transition")).toBeInTheDocument();
    });
  });

  it("applique la transition au téléphone physique en paysage malgré une largeur supérieure à 768px", async () => {
    installLandscapePhoneViewport();

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-303" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-viewport-mode", "mobile");
      expect(document.querySelector(".task-detail-modal--mobile-transition")).toBeInTheDocument();
    });
  });

  it("does NOT apply the mobile transition class on desktop", async () => {
    setViewportWidth(DESKTOP_WIDTH);

    render(
      <TaskDetailModal
        task={makeTask({ id: "FN-301" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".task-detail-modal")).toBeInTheDocument();
    });
    expect(document.querySelector(".task-detail-modal--mobile-transition")).not.toBeInTheDocument();
  });

  it("does not leave a lingering transition class after re-rendering at desktop width", async () => {
    setViewportWidth(MOBILE_WIDTH);

    const { rerender } = render(
      <TaskDetailModal
        task={makeTask({ id: "FN-302" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".task-detail-modal--mobile-transition")).toBeInTheDocument();
    });

    setViewportWidth(DESKTOP_WIDTH);
    rerender(
      <TaskDetailModal
        task={makeTask({ id: "FN-302" })}
        onClose={noop}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".task-detail-modal--mobile-transition")).not.toBeInTheDocument();
    });
  });
});
