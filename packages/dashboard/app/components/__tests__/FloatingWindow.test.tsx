import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss, loadStylesCss } from "../../test/cssFixture";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, FloatingWindow } from "../FloatingWindow";
import { readAppFile } from "../../test/cssFixture";
import { dragWithTouch, expectFloatingWindowStructure, resizeWithTouch } from "./floatingWindowMigration.test-helpers";

const floatingWindowCss = readAppFile("components/FloatingWindow.css");
const chatViewCss = readAppFile("components/ChatView.css");
const allAppCss = loadAllAppCss();
const stylesCss = loadStylesCss();

const FN_8606_WINDOW_IDENTITIES = [
  ["ActivityLogModal.tsx", "activity-log"], ["ScriptsModal.tsx", "scripts"], ["ScheduledTasksModal.tsx", "automation"],
  ["SettingsModal.tsx", "settings"], ["GitManagerModal.tsx", "git-manager"], ["PlanningModeModal.tsx", "planning-mode"],
  ["ChangesDiffModal.tsx", "changes-diff"], ["ModelOnboardingModal.tsx", "model-onboarding"], ["AddNodeModal.tsx", "add-node"],
  ["ConnectNodeModal.tsx", "connect-node"], ["NodeDetailModal.tsx", "node-detail"], ["WorkflowAddStepModal.tsx", "workflow-add-step"],
  ["GroupTaskModal.tsx", "group-task"],
] as const;

const QUICK_CHAT_PORTALED_MENU_CLASSES = [
  "model-combobox-dropdown--portal",
  "model-nested-menu--portal",
  "dep-dropdown--portal",
  "node-picker-dropdown--portal",
  "agent-picker-dropdown--portal",
  "priority-picker-dropdown--portal",
  "activity-view-menu",
] as const;

function cssRuleFor(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

function cssRuleContaining(css: string, selector: string, declaration: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
  const matches = css.matchAll(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "g"));
  for (const match of matches) {
    if (match[0].includes(declaration)) return match[0];
  }
  return "";
}

function cssRulesForClass(css: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`\\.${escaped}[^{}]*\\{[^}]*\\}`, "g"))].map((match) => match[0]);
}

/*
FNXC:FloatingWindow 2026-07-17-08:20:
The FN-8015 desktop resize-hot-zone invariant only governs desktop widths. The
mobile full-screen sheet variants hide every resize handle, so removing the
inherited body gutter there is legitimate (and required — see the mobile
task-detail left-shift fix). Strip `@media` blocks with balanced-brace matching
before scanning so the desktop invariant ignores mobile-only overrides.
*/
function stripAtMediaBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    i = j;
  }
  return out;
}

function mediaBlockFor(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 1;
  let index = open + 1;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}") depth--;
    index++;
  }
  return css.slice(open + 1, index - 1);
}

function setSheetViewport(isSheetWidth: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 767.98px)" ? isSheetWidth : query === "(max-height: 480px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

/*
FNXC:FloatingWindow 2026-06-22-20:45:
Contract tests for the reusable non-blocking floating window:
- the overlay is click-through (pointer-events:none) so the page and other windows behind it stay interactive,
- the panel re-enables pointer events and carries a header drag handle + resize handles,
- focus-to-front raises this window's z-index above any previously-opened window,
- close removes the window (onClose fires).
JSDOM has no real layout/pointer-capture, so drag math is asserted in the RightDockExpandModal pattern's own suite; here we assert the structural + stacking contract that makes multiple coexisting windows non-blocking.
*/

describe("FloatingWindow", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("renders a non-blocking, click-through transparent overlay with a pointer-events:auto panel", () => {
    render(
      <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}}>
        <div>alpha body</div>
      </FloatingWindow>
    );
    const overlay = screen.getByTestId("floating-window-overlay-alpha");
    // styles.css is not loaded here, so assert via the class contract the CSS attaches pointer-events:none to.
    expect(overlay.className).toContain("floating-window-overlay");
    const panel = screen.getByTestId("floating-window-alpha");
    expect(panel.className).toContain("floating-window");
    // Panel is positioned/stacked via inline style.
    expect(panel.style.position === "" || panel.style.left).toBeDefined();
    expect(panel.style.zIndex).not.toBe("");
  });

  it("exposes a header drag handle and resize handles", () => {
    render(
      <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}}>
        <div>beta body</div>
      </FloatingWindow>
    );
    expect(screen.getByTestId("floating-window-drag-handle-beta")).toBeTruthy();
    expectFloatingWindowStructure("beta");
  });

  it("keeps every shared floating-window scrollbar inboard of the right resize hot zones", () => {
    const bodyRule = floatingWindowCss.match(/(?:^|\n)\.floating-window__body\s*\{[^}]*\}/)?.[0] ?? "";

    // The global scrollbar is 8px wide; the shared body reserves the 12px corner-handle gutter.
    expect(stylesCss).toContain("*::-webkit-scrollbar {");
    expect(stylesCss).toContain("width: 8px;");
    expect(bodyRule).toContain("overflow: auto;");
    expect(bodyRule).toContain("margin-inline-end: var(--space-lg);");
    expect(cssRuleContaining(floatingWindowCss, ".floating-window__resize-handle--e", "right: 0;")).toContain("right: 0;");
    expect(cssRuleContaining(floatingWindowCss, ".floating-window__resize-handle--ne", "right: 0;")).toContain("right: 0;");
    expect(cssRuleContaining(floatingWindowCss, ".floating-window__resize-handle--se", "right: 0;")).toContain("right: 0;");

    // No shared caller may move a right handle back into the reserved scrollbar
    // gutter, nor override the body gutter, AT DESKTOP WIDTHS. Mobile full-screen
    // sheet overrides (inside @media) are legitimate and excluded from this scan.
    const desktopAppCss = stripAtMediaBlocks(allAppCss);
    for (const callerClass of [
      "floating-window--task-detail",
      "floating-window--automation",
      "floating-window--mission-interview",
      "floating-window--pr-create",
      "floating-window--file-browser",
      "floating-window--workflow-editor",
      "artifacts-gallery-window",
    ]) {
      const rules = cssRulesForClass(desktopAppCss, callerClass);
      const rightHandleRules = rules.filter((rule) => /floating-window__resize-handle(?:--(?:e|ne|se))?/.test(rule));
      const bodyRules = rules.filter((rule) => rule.includes("floating-window__body"));

      expect(rightHandleRules.some((rule) => /(?:right|width)\s*:/.test(rule)), callerClass).toBe(false);
      expect(bodyRules.some((rule) => /margin-inline-end\s*:/.test(rule)), callerClass).toBe(false);
    }

    /*
    FNXC:MobileTaskPopups 2026-07-17-08:20:
    Regression guard for the mobile task-detail left-shift fix: the full-screen
    task-detail sheet hides all resize handles, so FN-8015's inherited
    `margin-inline-end: var(--space-lg)` body gutter only added dead space on the
    right and shifted the whole panel left. The mobile breakpoint must zero it so
    `.detail-body`'s own padding defines both insets equally. This is the sole
    legitimate body-gutter override and lives only inside the mobile @media block.
    */
    const mobileTaskDetailBody = cssRuleContaining(
      allAppCss,
      ".floating-window--task-detail .floating-window__body",
      "margin-inline-end",
    );
    expect(mobileTaskDetailBody).toContain("margin-inline-end: 0;");
    expect(cssRulesForClass(desktopAppCss, "floating-window--task-detail").some((rule) => rule.includes("floating-window__body"))).toBe(false);

    /*
    FNXC:ModalTouchGeometry 2026-08-01-03:48:
    Tablet contract: ALL tablet-mode floating windows zero the FN-8015 gutter (it read as a
    too-big uneven right border in Task Detail popups and the floating terminal — third
    recurrence of the right-padding bug because tablet renders through FloatingWindow, not
    `.modal-overlay`). Touch never grabs scrollbar thumbs, so the desktop hot-zone conflict
    does not apply. GitHubImport relied on the gutter as its right inset and must compensate
    under the same class.
    */
    const tabletBody = cssRuleContaining(
      floatingWindowCss,
      ".floating-window--tablet-viewport .floating-window__body",
      "margin-inline-end",
    );
    expect(tabletBody).toContain("margin-inline-end: 0;");
    const tabletGitHubImportPanel = cssRuleContaining(
      allAppCss,
      ".floating-window--tablet-viewport .github-import-detail-panel",
      "padding-inline-end",
    );
    expect(tabletGitHubImportPanel).toContain("padding-inline-end: var(--space-lg);");

    // Headerless and chat variants replace only body overflow; the inherited gutter remains intact for their inner scrollers.
    expect(cssRuleFor(floatingWindowCss, ".floating-window--headerless .floating-window__body")).toContain("overflow: hidden;");
    expect(cssRuleFor(floatingWindowCss, ".floating-window--chat.floating-window--headerless .floating-window__body")).toContain("overflow: hidden;");
  });

  /*
  FNXC:FloatingWindow 2026-07-25-00:00:
  Regression guard for the landscape-tablet right-inset gap: the width-gated
  769-1024px carve-out let iPad Air/Pro landscape (1180-1366 CSS px) fall back to
  the desktop contract and keep FN-8015's body gutter, so the task pop-up's
  content stopped short of the right edge while the left edge stayed flush.
  Assert the input-device-gated block covers the same two declarations at ANY
  width, and that it stays scoped to task-detail so other floating-window callers
  (whose right resize handles remain live) keep their scrollbar clearance.
  */
  it("uses the tablet-touch discriminator instead of bare coarse-pointer suppression", () => {
    expect(floatingWindowCss).not.toContain("@media (pointer: coarse)");
    expect(floatingWindowCss).not.toContain("max-width: 768px");
    expect(floatingWindowCss).toContain("@media (max-width: 767.98px)");
    expect(floatingWindowCss).toContain(".floating-window--touch-geometry .floating-window__resize-handle");
    expect(floatingWindowCss).toContain("width: var(--modal-resize-touch-target);");
    expect(floatingWindowCss).toContain("margin-inline-end: var(--space-lg);");

    const phoneBlock = mediaBlockFor(floatingWindowCss, "(max-width: 767.98px)");
    expect(cssRuleFor(phoneBlock, ".floating-window--task-detail .floating-window__resize-handle")).toContain("display: none;");
  });

  /*
  FNXC:ModalTouchGeometry 2026-08-01-03:48:
  Tablet MODE is its own styling marker, distinct from `--touch-geometry`: a non-touch window
  at tablet widths must still receive `floating-window--tablet-viewport` so the FN-8015 gutter zeroing
  applies everywhere the app classifies the viewport as tablet.
  */
  it("marks tablet-mode windows with floating-window--tablet-viewport even without touch", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(min-width: 769px) and (max-width: 1024px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(
      <FloatingWindow windowKey="tablet-mode" title="Tablet" onClose={() => {}}>
        <div>tablet body</div>
      </FloatingWindow>
    );
    const panel = screen.getByTestId("floating-window-tablet-mode");
    expect(panel.className).toContain("floating-window--tablet-viewport");
  });

  it("keeps task-detail long content clear of right handles while preserving short-content right-edge resize", () => {
    const longContent = Array.from({ length: 40 }, (_, index) => <p key={index}>Scrollable task detail {index}</p>);
    const { unmount } = render(
      <FloatingWindow
        windowKey="task-long-content"
        title="FN-8015"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".task-detail-content--embedded > .modal-header"
        className="floating-window--task-detail"
      >
        <div className="task-detail-content--embedded">
          <div className="modal-header">FN-8015</div>
          <div>{longContent}</div>
        </div>
      </FloatingWindow>
    );

    expect(screen.getByTestId("floating-window-body-task-long-content")).toHaveClass("floating-window__body");
    for (const direction of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(screen.getByTestId(`floating-window-resize-${direction}`)).toBeTruthy();
    }
    unmount();

    render(
      <FloatingWindow
        windowKey="task-short-content"
        title="FN-8015"
        onClose={() => {}}
        defaultSize={{ width: 320, height: 240 }}
        defaultPosition={{ x: 80, y: 90 }}
        minSize={{ width: 240, height: 180 }}
        className="floating-window--task-detail"
      >
        <div>Short task detail</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-task-short-content");
    const eastHandle = screen.getByTestId("floating-window-resize-e");
    Object.defineProperty(eastHandle, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(eastHandle, "releasePointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(eastHandle, { pointerId: 31, clientX: 400, clientY: 180 });
    fireEvent.pointerMove(eastHandle, { pointerId: 31, clientX: 440, clientY: 180 });
    fireEvent.pointerUp(eastHandle, { pointerId: 31, clientX: 440, clientY: 180 });

    expect(panel.style.width).toBe("360px");
  });

  it("uses a theme-overridable gentle shadow token instead of an undefined shadow", () => {
    const windowRule = floatingWindowCss.match(/\.floating-window\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(windowRule).toContain("--floating-window-shadow: var(--shadow-lg);");
    expect(windowRule).toContain("box-shadow: var(--floating-window-shadow, var(--shadow-lg));");
    expect(floatingWindowCss).not.toContain("var(--shadow-xl)");
  });

  it("keeps movable mobile drag handles opted out of the pan-y touch lockdown", () => {
    expect(allAppCss).toContain("html,");
    expect(allAppCss).toContain("body {");
    expect(allAppCss).toContain("touch-action: pan-y;");
    expect(allAppCss).toContain("* {");
    expect(allAppCss).toContain("#root {");

    const movableFloatingWindowSelector = ".floating-window:not(.floating-window--chat):not(.floating-window--github-import-detail):not(.floating-window--task-detail):not(.floating-window--workflow-editor):not(.floating-window--automation):not(.floating-window--mission-interview):not(.floating-window--file-browser):not(.floating-window--pr-create):not(.floating-window--activity-log):not(.floating-window--scripts):not(.floating-window--add-node):not(.floating-window--connect-node):not(.floating-window--node-detail):not(.floating-window--workflow-add-step):not(.floating-window--group-task):not(.floating-window--changes-diff):not(.floating-window--model-onboarding):not(.floating-window--git-manager):not(.floating-window--settings):not(.floating-window--planning-mode):not(.artifacts-gallery-window) .floating-window__header";
    expect(cssRuleFor(floatingWindowCss, movableFloatingWindowSelector)).toContain("touch-action: none;");

    for (const selector of [
      ".right-dock-expand-modal__header--draggable",
    ]) {
      expect(cssRuleFor(allAppCss, selector)).toContain("touch-action: none;");
    }
  });

  it("maps every FN-8606 modal to the required shared window identity and sheet suspension", () => {
    for (const [file, windowKey] of FN_8606_WINDOW_IDENTITIES) {
      const source = readAppFile(`components/${file}`);
      expect(source, file).toContain(`<FloatingWindow`);
      expect(source, file).toContain(`windowKey=\"${windowKey}\"`);
      expect(source, file).toContain(`className=\"floating-window--${windowKey}\"`);
      expect(source, file).toContain(`persistGeometryKey=\"floating-window:${windowKey}\"`);
      expect(source, file).toContain("suspendGeometryPersistenceOnMobile");
      expect(source, file).toContain("suspendGeometryPersistenceOnShortViewport");
    }
  });

  it("gives only delegated Quick Chat headers a larger tablet touch target", () => {
    const tabletRule = mediaBlockFor(
      chatViewCss,
      "(min-width: 769px) and (max-width: 1024px) and (min-height: 481px)",
    );
    const floatingHeaderRule = cssRuleFor(chatViewCss, ".chat-view--floating .view-header");

    expect(tabletRule).toContain(".chat-view--floating .view-header");
    expect(tabletRule).toContain("min-height: calc(var(--view-header-min-height) + var(--space-sm));");
    expect(tabletRule).toContain("height: calc(var(--view-header-min-height) + var(--space-sm));");
    expect(floatingHeaderRule).toContain("cursor: grab;");
    expect(floatingHeaderRule).toContain("user-select: none;");
    expect(floatingHeaderRule).toContain("touch-action: none;");

    // The explicit tablet query leaves the ≤768px sheet and >1024px desktop header geometry canonical.
    expect(chatViewCss).not.toMatch(/@media \(max-width: 768px\)\s*\{\s*\.chat-view--floating \.view-header\s*\{/);
    expect(chatViewCss).not.toMatch(/@media \(min-width: 1025px\)[\s\S]*\.chat-view--floating \.view-header/);
  });

  it("keeps every tablet movable-modal drag handle on the explicit touch-action none contract", () => {
    const tabletStylesStart = stylesCss.indexOf("@media (min-width: 769px) and (max-width: 1024px)");
    const mobileStylesStart = stylesCss.indexOf("@media (max-width: 768px)", tabletStylesStart);
    expect(tabletStylesStart).toBeGreaterThan(-1);
    expect(mobileStylesStart).toBeGreaterThan(tabletStylesStart);

    const tabletBlock = stylesCss.slice(tabletStylesStart, mobileStylesStart);
    expect(tabletBlock).not.toContain("* {");
    expect(tabletBlock).not.toContain("touch-action: pan-y;");

    for (const selector of [
      ".floating-window__header",
      ".floating-window--headerless .task-detail-content--embedded > .modal-header",
      ".chat-view--floating .view-header",
      ".floating-window--workflow-editor .wf-editor-header",
      ".floating-window--automation .automation-modal__drag-handle",
      ".floating-window--mission-interview .mission-interview-modal__drag-handle",
      ".floating-window--pr-create .pr-create-modal__drag-handle",
      ".file-browser-modal-header",
      ".artifacts-gallery-viewer-header",
      ".right-dock-expand-modal__header--draggable",
      ".new-task-modal__header--draggable",
      ".quick-chat-fab",
    ]) {
      expect(cssRuleContaining(allAppCss, selector, "touch-action: none;"), selector).toContain("touch-action: none;");
    }
  });

  it("moves a visible-header window through the captured touch drag path", () => {
    render(
      <FloatingWindow
        windowKey="touch-drag"
        title="A very long movable floating window title that still starts drag from the ellipsized title text"
        onClose={() => {}}
        defaultSize={{ width: 320, height: 240 }}
        defaultPosition={{ x: 80, y: 90 }}
        minSize={{ width: 240, height: 180 }}
      >
        <div>touch drag body</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-touch-drag");
    const header = screen.getByTestId("floating-window-drag-handle-touch-drag");
    const titleText = screen.getByText(/very long movable floating window title/i);
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(header, "setPointerCapture", { configurable: true, value: setPointerCapture });
    Object.defineProperty(header, "releasePointerCapture", { configurable: true, value: releasePointerCapture });

    fireEvent.pointerDown(titleText, { pointerId: 17, pointerType: "touch", clientX: 100, clientY: 120 });
    fireEvent.pointerMove(header, { pointerId: 17, pointerType: "touch", clientX: 140, clientY: 150 });
    fireEvent.pointerUp(header, { pointerId: 17, pointerType: "touch", clientX: 140, clientY: 150 });

    expect(setPointerCapture).toHaveBeenCalledWith(17);
    expect(releasePointerCapture).toHaveBeenCalledWith(17);
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("120px");
  });

  it("can hide generic chrome and delegate dragging to a child header", () => {
    render(
      <FloatingWindow
        windowKey="task"
        title="KB-001"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".task-detail-content--embedded > .modal-header"
        className="floating-window--task-detail"
      >
        <div className="task-detail-content--embedded">
          <div className="modal-header">KB-001</div>
          <div>task body</div>
        </div>
      </FloatingWindow>
    );

    expect(screen.queryByTestId("floating-window-drag-handle-task")).toBeNull();
    expect(screen.getByTestId("floating-window-task")).toHaveClass("floating-window--headerless");
    expect(screen.getByTestId("floating-window-task")).toHaveClass("floating-window--task-detail");
    expect(screen.getByText("KB-001")).toBeInTheDocument();
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(screen.getByTestId(`floating-window-resize-${dir}`)).toBeTruthy();
    }
  });

  it("moves a headerless delegated handle through the captured tablet touch drag path", () => {
    render(
      <FloatingWindow
        windowKey="artifacts-delegate"
        title="Artifacts"
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".artifacts-gallery-viewer-header"
        className="artifacts-gallery-window"
        defaultSize={{ width: 320, height: 240 }}
        defaultPosition={{ x: 90, y: 110 }}
        minSize={{ width: 240, height: 180 }}
      >
        <div className="artifacts-gallery-viewer-header">Artifacts header</div>
        <div aria-label="empty artifacts body" />
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-artifacts-delegate");
    const delegatedHeader = screen.getByText("Artifacts header");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(panel, "setPointerCapture", { configurable: true, value: setPointerCapture });
    Object.defineProperty(panel, "releasePointerCapture", { configurable: true, value: releasePointerCapture });

    fireEvent.pointerDown(delegatedHeader, { pointerId: 23, pointerType: "touch", clientX: 120, clientY: 140 });
    fireEvent.pointerMove(panel, { pointerId: 23, pointerType: "touch", clientX: 150, clientY: 170 });
    fireEvent.pointerUp(panel, { pointerId: 23, pointerType: "touch", clientX: 150, clientY: 170 });

    expect(setPointerCapture).toHaveBeenCalledWith(23);
    expect(releasePointerCapture).toHaveBeenCalledWith(23);
    expect(panel.style.left).toBe("120px");
    expect(panel.style.top).toBe("140px");
  });

  it("scopes mobile sheet sizing and hidden resize handles to task-detail pop-outs", () => {
    expect(floatingWindowCss).toContain("FNXC:MobileTaskPopups 2026-06-29-00:00");
    expect(floatingWindowCss).toContain(".floating-window--task-detail {");
    expect(floatingWindowCss).toContain("width: 100vw !important;");
    expect(floatingWindowCss).toContain("height: 100dvh !important;");
    expect(floatingWindowCss).toContain(".floating-window--task-detail .floating-window__resize-handle");
    expect(floatingWindowCss).toContain("display: none;");
    expect(floatingWindowCss).toContain("cursor: default;");
    expect(floatingWindowCss).toContain("touch-action: auto;");
  });

  it("does not apply task-detail mobile sizing to chat floating windows", () => {
    const taskRuleIndex = floatingWindowCss.indexOf(".floating-window--task-detail {");
    const chatRuleIndex = floatingWindowCss.indexOf(".floating-window--chat {");

    expect(taskRuleIndex).toBeGreaterThan(-1);
    expect(chatRuleIndex).toBeGreaterThan(-1);
    expect(taskRuleIndex).not.toBe(chatRuleIndex);
  });

  it("focus-to-front: interacting with an older utility window raises its z-index above the newest utility window", () => {
    render(
      <>
        <FloatingWindow windowKey="first" title="First" onClose={() => {}}>
          <div>first</div>
        </FloatingWindow>
        <FloatingWindow windowKey="second" title="Second" onClose={() => {}}>
          <div>second</div>
        </FloatingWindow>
      </>
    );
    const first = screen.getByTestId("floating-window-first");
    const second = screen.getByTestId("floating-window-second");
    // Second mounted last → starts on top.
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex));
    // Clicking the first panel raises it above the second.
    fireEvent.pointerDown(first);
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex));
  });

  it("keeps task-detail popups in the board layer while allowing raise among task popups", () => {
    render(
      <>
        <FloatingWindow windowKey="task-a" title="Task A" onClose={() => {}} layer="task-detail" className="floating-window--task-detail">
          <div>task a</div>
        </FloatingWindow>
        <FloatingWindow windowKey="task-b" title="Task B" onClose={() => {}} layer="task-detail" className="floating-window--task-detail">
          <div>task b</div>
        </FloatingWindow>
        <FloatingWindow windowKey="utility" title="Utility" onClose={() => {}}>
          <div>utility</div>
        </FloatingWindow>
      </>,
    );

    const taskA = screen.getByTestId("floating-window-task-a");
    const taskB = screen.getByTestId("floating-window-task-b");
    const utility = screen.getByTestId("floating-window-utility");
    const taskAOverlay = screen.getByTestId("floating-window-overlay-task-a");
    const utilityOverlay = screen.getByTestId("floating-window-overlay-utility");

    expect(Number(taskB.style.zIndex)).toBeGreaterThan(Number(taskA.style.zIndex));
    expect(Number(utility.style.zIndex)).toBeGreaterThan(Number(taskB.style.zIndex));
    expect(Number(utilityOverlay.style.zIndex)).toBeGreaterThan(Number(taskAOverlay.style.zIndex));

    fireEvent.pointerDown(taskA);
    expect(Number(taskA.style.zIndex)).toBeGreaterThan(Number(taskB.style.zIndex));
    expect(Number(taskA.style.zIndex)).toBeLessThan(Number(utility.style.zIndex));
  });

  it("close button removes the window via onClose", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="gamma" title="Gamma" onClose={onClose}>
        <div>gamma body</div>
      </FloatingWindow>
    );
    fireEvent.click(screen.getByTestId("floating-window-close-gamma"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside pointerdown only when the opt-in prop is enabled", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="outside-close" title="Outside close" onClose={onClose} closeOnOutsidePointerDown>
        <div>inside body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close for inside pointerdown when outside dismissal is enabled", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="inside-safe" title="Inside safe" onClose={onClose} closeOnOutsidePointerDown>
        <button type="button">Inside action</button>
      </FloatingWindow>
    );

    fireEvent.pointerDown(screen.getByText("Inside action"));
    fireEvent.pointerDown(screen.getByTestId("floating-window-body-inside-safe"));
    fireEvent.pointerDown(screen.getByTestId("floating-window-inside-safe"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps page clicks non-dismissive by default for persistent floating windows", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="persistent" title="Persistent" onClose={onClose}>
        <div>persistent body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on outside pointerdown when the opt-in prop is explicitly false", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="outside-disabled" title="Outside disabled" onClose={onClose} closeOnOutsidePointerDown={false}>
        <div>chat body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when the outside target is another floating or dialog surface", () => {
    for (const surfaceClassOrRole of ["modal-overlay", "floating-window", "dialog-role"] as const) {
      const onClose = vi.fn();
      const { unmount } = render(
        <FloatingWindow windowKey={`nested-${surfaceClassOrRole}`} title="Nested safe" onClose={onClose} closeOnOutsidePointerDown>
          <div>chat body</div>
        </FloatingWindow>
      );
      const surface = document.createElement("div");
      if (surfaceClassOrRole === "dialog-role") {
        surface.setAttribute("role", "dialog");
      } else {
        surface.className = surfaceClassOrRole;
      }
      document.body.appendChild(surface);

      fireEvent.pointerDown(surface);

      expect(onClose).not.toHaveBeenCalled();
      surface.remove();
      unmount();
    }
  });

  it("does not close when pointerdown targets Quick Chat's body-portaled dropdown surfaces", () => {
    for (const portalClassName of QUICK_CHAT_PORTALED_MENU_CLASSES) {
      const onClose = vi.fn();
      const { unmount } = render(
        <FloatingWindow windowKey={`portal-safe-${portalClassName}`} title="Portal safe" onClose={onClose} closeOnOutsidePointerDown>
          <div>chat body</div>
        </FloatingWindow>
      );
      const portalSurface = document.createElement("div");
      portalSurface.className = portalClassName;
      document.body.appendChild(portalSurface);

      fireEvent.pointerDown(portalSurface);

      expect(onClose).not.toHaveBeenCalled();
      portalSurface.remove();
      unmount();
    }
  });

  it("does not close when pointerdown targets an element inside a Quick Chat body-portaled dropdown", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="portal-child-safe" title="Portal child safe" onClose={onClose} closeOnOutsidePointerDown>
        <div>chat body</div>
      </FloatingWindow>
    );
    const portalSurface = document.createElement("div");
    portalSurface.className = "model-combobox-dropdown--portal";
    const option = document.createElement("button");
    option.type = "button";
    option.textContent = "Model option";
    portalSurface.appendChild(option);
    document.body.appendChild(portalSurface);

    fireEvent.pointerDown(option);

    expect(onClose).not.toHaveBeenCalled();
    portalSurface.remove();
  });

  it("does not close from outside pointerdown while a resize gesture is active", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="resize-safe" title="Resize safe" onClose={onClose} closeOnOutsidePointerDown>
        <div>resize body</div>
      </FloatingWindow>
    );

    fireEvent.pointerDown(screen.getByTestId("floating-window-resize-se"), { pointerId: 1 });
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores compatibility pointer events immediately after touch gestures", () => {
    const onClose = vi.fn();
    render(
      <FloatingWindow windowKey="touch-safe" title="Touch safe" onClose={onClose} closeOnOutsidePointerDown>
        <div>touch body</div>
      </FloatingWindow>
    );

    expect(onClose).not.toHaveBeenCalled();
    fireEvent.touchStart(document);
    fireEvent.touchEnd(document);
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("removes the outside pointerdown listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <FloatingWindow windowKey="cleanup" title="Cleanup" onClose={onClose} closeOnOutsidePointerDown>
        <div>cleanup body</div>
      </FloatingWindow>
    );

    unmount();
    fireEvent.pointerDown(document.body);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("multiple windows coexist independently (each renders its own panel)", () => {
    render(
      <>
        <FloatingWindow windowKey="w1" title="W1" onClose={() => {}}>
          <div>one</div>
        </FloatingWindow>
        <FloatingWindow windowKey="w2" title="W2" onClose={() => {}}>
          <div>two</div>
        </FloatingWindow>
        <FloatingWindow windowKey="w3" title="W3" onClose={() => {}}>
          <div>three</div>
        </FloatingWindow>
      </>
    );
    expect(screen.getByTestId("floating-window-w1")).toBeTruthy();
    expect(screen.getByTestId("floating-window-w2")).toBeTruthy();
    expect(screen.getByTestId("floating-window-w3")).toBeTruthy();
  });

  it("restores persisted geometry and clamps it on screen", () => {
    localStorage.setItem(
      "floating-window:test",
      JSON.stringify({
        size: { width: 700, height: 500 },
        position: { x: 9999, y: -200 },
      }),
    );

    render(
      <FloatingWindow
        windowKey="persisted"
        title="Persisted"
        onClose={() => {}}
        persistGeometryKey="floating-window:test"
        minSize={{ width: 360, height: 280 }}
      >
        <div>persisted body</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-persisted");
    expect(panel.style.width).toBe("700px");
    expect(panel.style.height).toBe("500px");
    expect(panel.style.top).toBe("16px");
    expect(Number.parseFloat(panel.style.left)).toBeLessThan(window.innerWidth);
  });

  it("reloads persisted geometry when a mounted host changes its project-scoped identity", () => {
    const firstKey = "floating-window:project-one";
    const secondKey = "floating-window:project-two";
    const firstGeometry = { size: { width: 610, height: 430 }, position: { x: 80, y: 90 } };
    const secondGeometry = { size: { width: 700, height: 500 }, position: { x: 120, y: 110 } };
    localStorage.setItem(firstKey, JSON.stringify(firstGeometry));
    localStorage.setItem(secondKey, JSON.stringify(secondGeometry));

    const { rerender } = render(
      <FloatingWindow windowKey="terminal-project-one" title="Terminal" onClose={() => {}} persistGeometryKey={firstKey}>
        <div>terminal body</div>
      </FloatingWindow>,
    );
    expect(screen.getByTestId("floating-window-terminal-project-one")).toHaveStyle({ width: "610px", height: "430px" });

    rerender(
      <FloatingWindow windowKey="terminal-project-two" title="Terminal" onClose={() => {}} persistGeometryKey={secondKey}>
        <div>terminal body</div>
      </FloatingWindow>,
    );

    expect(screen.getByTestId("floating-window-terminal-project-two")).toHaveStyle({ width: "700px", height: "500px" });
    expect(JSON.parse(localStorage.getItem(firstKey) ?? "{}")).toEqual(firstGeometry);
  });

  it("falls back to default geometry when persisted geometry is malformed", () => {
    localStorage.setItem("floating-window:malformed", "not-json");

    render(
      <FloatingWindow
        windowKey="malformed"
        title="Malformed"
        onClose={() => {}}
        persistGeometryKey="floating-window:malformed"
        defaultSize={{ width: 610, height: 430 }}
        defaultPosition={{ x: 80, y: 90 }}
      >
        <div>malformed body</div>
      </FloatingWindow>
    );

    const panel = screen.getByTestId("floating-window-malformed");
    expect(panel.style.width).toBe("610px");
    expect(panel.style.height).toBe("430px");
    expect(panel.style.left).toBe("80px");
    expect(panel.style.top).toBe("90px");
  });

  it("preserves desktop geometry during opt-in sheet opens and restores it on desktop", () => {
    const key = "floating-window:sheet-preserve";
    const desktopGeometry = { size: { width: 640, height: 460 }, position: { x: 120, y: 96 } };
    localStorage.setItem(key, JSON.stringify(desktopGeometry));
    setSheetViewport(true);

    const { unmount } = render(
      <FloatingWindow
        windowKey="sheet-preserve-mobile"
        title="Sheet"
        onClose={() => {}}
        persistGeometryKey={key}
        suspendGeometryPersistenceOnMobile
        defaultSize={{ width: 500, height: 400 }}
        defaultPosition={{ x: 32, y: 48 }}
      >
        <div>sheet body</div>
      </FloatingWindow>,
    );

    const sheetPanel = screen.getByTestId("floating-window-sheet-preserve-mobile");
    expect(sheetPanel.style.width).toBe("500px");
    expect(sheetPanel.style.left).toBe("32px");
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual(desktopGeometry);
    unmount();

    setSheetViewport(false);
    render(
      <FloatingWindow windowKey="sheet-preserve-desktop" title="Desktop" onClose={() => {}} persistGeometryKey={key} suspendGeometryPersistenceOnMobile>
        <div>desktop body</div>
      </FloatingWindow>,
    );
    const desktopPanel = screen.getByTestId("floating-window-sheet-preserve-desktop");
    expect(desktopPanel.style.width).toBe("640px");
    expect(desktopPanel.style.height).toBe("460px");
    expect(desktopPanel.style.left).toBe("120px");
    expect(desktopPanel.style.top).toBe("96px");
  });

  it("preserves opt-in geometry during a short-viewport full-screen sheet", () => {
    const key = "floating-window:short-sheet";
    const desktopGeometry = { size: { width: 640, height: 460 }, position: { x: 120, y: 96 } };
    localStorage.setItem(key, JSON.stringify(desktopGeometry));
    setSheetViewport(false);

    render(
      <FloatingWindow
        windowKey="short-sheet"
        title="Short sheet"
        onClose={() => {}}
        persistGeometryKey={key}
        suspendGeometryPersistenceOnMobile
        suspendGeometryPersistenceOnShortViewport
        defaultSize={{ width: 500, height: 400 }}
        defaultPosition={{ x: 32, y: 48 }}
      >
        <div>short sheet body</div>
      </FloatingWindow>,
    );

    const sheetPanel = screen.getByTestId("floating-window-short-sheet");
    expect(sheetPanel.style.width).toBe("500px");
    expect(sheetPanel.style.left).toBe("32px");
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual(desktopGeometry);
  });

  it("keeps opt-in geometry persistence on wide short landscape phones that remain movable", () => {
    const key = "floating-window:landscape-phone";
    localStorage.setItem(key, JSON.stringify({ size: { width: 620, height: 450 }, position: { x: 100, y: 80 } }));
    // `isMobileViewport()` would be true for this max-height match, but sheets use only max-width.
    setSheetViewport(false);

    render(
      <FloatingWindow windowKey="landscape-phone" title="Landscape" onClose={() => {}} persistGeometryKey={key} suspendGeometryPersistenceOnMobile>
        <div>landscape body</div>
      </FloatingWindow>,
    );

    const panel = screen.getByTestId("floating-window-landscape-phone");
    expect(panel.style.width).toBe("620px");
    expect(panel.style.left).toBe("100px");
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual({ size: { width: 620, height: 450 }, position: { x: 100, y: 80 } });
  });

  it("suppresses header drag and persistence in an opt-in short sheet", () => {
    const key = "floating-window:short-sheet-gesture";
    setSheetViewport(false);
    render(
      <FloatingWindow
        windowKey="short-sheet-gesture"
        title="Short sheet"
        onClose={() => {}}
        persistGeometryKey={key}
        suspendGeometryPersistenceOnMobile
        suspendGeometryPersistenceOnShortViewport
        defaultPosition={{ x: 80, y: 90 }}
      >
        <div>short sheet body</div>
      </FloatingWindow>,
    );

    const panel = screen.getByTestId("floating-window-short-sheet-gesture");
    const header = screen.getByTestId("floating-window-drag-handle-short-sheet-gesture");
    fireEvent.pointerDown(header, { pointerId: 91, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, { pointerId: 91, pointerType: "touch", clientX: 160, clientY: 150 });
    fireEvent.pointerUp(header, { pointerId: 91, pointerType: "touch", clientX: 160, clientY: 150 });

    expect(panel.style.left).toBe("80px");
    expect(panel.style.top).toBe("90px");
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("continues persistence at sheet width when suspension is not opted in", () => {
    const key = "floating-window:sheet-default";
    const geometry = { size: { width: 610, height: 440 }, position: { x: 90, y: 72 } };
    localStorage.setItem(key, JSON.stringify(geometry));
    setSheetViewport(true);

    render(
      <FloatingWindow windowKey="sheet-default" title="Default" onClose={() => {}} persistGeometryKey={key}>
        <div>default body</div>
      </FloatingWindow>,
    );

    const panel = screen.getByTestId("floating-window-sheet-default");
    expect(panel.style.width).toBe("610px");
    expect(panel.style.left).toBe("90px");
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual(geometry);
  });

  it("shares geometry only between windows that opt into the same persistence key", () => {
    localStorage.setItem(
      "floating-window:shared-task-detail",
      JSON.stringify({
        size: { width: 660, height: 470 },
        position: { x: 120, y: 96 },
      }),
    );
    localStorage.setItem(
      "floating-window:chat",
      JSON.stringify({
        size: { width: 520, height: 390 },
        position: { x: 220, y: 140 },
      }),
    );

    render(
      <>
        <FloatingWindow
          windowKey="task-detail-FN-001"
          title="FN-001"
          onClose={() => {}}
          persistGeometryKey="floating-window:shared-task-detail"
        >
          <div>task one</div>
        </FloatingWindow>
        <FloatingWindow
          windowKey="task-detail-FN-002"
          title="FN-002"
          onClose={() => {}}
          persistGeometryKey="floating-window:shared-task-detail"
        >
          <div>task two</div>
        </FloatingWindow>
        <FloatingWindow windowKey="chat" title="Chat" onClose={() => {}} persistGeometryKey="floating-window:chat">
          <div>chat body</div>
        </FloatingWindow>
      </>
    );

    for (const id of ["FN-001", "FN-002"]) {
      const panel = screen.getByTestId(`floating-window-task-detail-${id}`);
      expect(panel.style.width).toBe("660px");
      expect(panel.style.height).toBe("470px");
      expect(panel.style.left).toBe("120px");
      expect(panel.style.top).toBe("96px");
    }

    const chatPanel = screen.getByTestId("floating-window-chat");
    expect(chatPanel.style.width).toBe("520px");
    expect(chatPanel.style.height).toBe("390px");
    expect(chatPanel.style.left).toBe("220px");
    expect(chatPanel.style.top).toBe("140px");
  });

  it("keeps hidden children mounted while suspending invisible-window effects and reclaiming the task-detail stack", () => {
    const onClose = vi.fn();
    const geometryEvents = vi.fn();
    const storageKey = "floating-window:hidden";
    window.addEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);

    const { rerender } = render(
      <>
        <FloatingWindow
          windowKey="hidden-chat"
          title="Chat"
          onClose={onClose}
          hidden
          closeOnOutsidePointerDown
          persistGeometryKey={storageKey}
          layer="task-detail"
        >
          <div data-testid="retained-hidden-child">retained chat</div>
        </FloatingWindow>
        <FloatingWindow windowKey="active-task" title="Task" onClose={() => {}} layer="task-detail">
          <div>active task</div>
        </FloatingWindow>
      </>,
    );

    const hiddenOverlay = screen.getByTestId("floating-window-overlay-hidden-chat");
    const retainedChild = screen.getByTestId("retained-hidden-child");
    const activeTask = screen.getByTestId("floating-window-active-task");
    const hiddenRule = cssRuleFor(floatingWindowCss, ".floating-window-overlay--hidden");
    expect(hiddenOverlay).toHaveClass("floating-window-overlay--hidden");
    expect(hiddenOverlay).toHaveAttribute("aria-hidden", "true");
    expect(hiddenRule).toContain("visibility: hidden;");
    expect(hiddenRule).toContain("pointer-events: none;");
    expect(hiddenRule).not.toMatch(/display\s*:\s*none/);
    expect(geometryEvents).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(storageKey)).toBeNull();
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <>
        <FloatingWindow
          windowKey="hidden-chat"
          title="Chat"
          onClose={onClose}
          closeOnOutsidePointerDown
          persistGeometryKey={storageKey}
          layer="task-detail"
        >
          <div data-testid="retained-hidden-child">retained chat</div>
        </FloatingWindow>
        <FloatingWindow windowKey="active-task" title="Task" onClose={() => {}} layer="task-detail">
          <div>active task</div>
        </FloatingWindow>
      </>,
    );

    const visibleOverlay = screen.getByTestId("floating-window-overlay-hidden-chat");
    const shownChat = screen.getByTestId("floating-window-hidden-chat");
    expect(visibleOverlay).not.toHaveClass("floating-window-overlay--hidden");
    expect(visibleOverlay).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("retained-hidden-child")).toBe(retainedChild);
    expect(geometryEvents).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    expect(Number(shownChat.style.zIndex)).toBeGreaterThan(Number(activeTask.style.zIndex));
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);
  });

  it("keeps the hidden prop opt-in so existing callers retain visible, interactive behavior", () => {
    const onClose = vi.fn();
    const geometryEvents = vi.fn();
    const storageKey = "floating-window:default-hidden-off";
    window.addEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);

    render(
      <FloatingWindow windowKey="default-hidden-off" title="Visible by default" onClose={onClose} closeOnOutsidePointerDown persistGeometryKey={storageKey}>
        <div>existing caller body</div>
      </FloatingWindow>,
    );

    const overlay = screen.getByTestId("floating-window-overlay-default-hidden-off");
    expect(overlay).not.toHaveClass("floating-window-overlay--hidden");
    expect(overlay).not.toHaveAttribute("aria-hidden");
    expect(geometryEvents).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);
  });

  /*
  FNXC:ModalTouchGeometry 2026-07-26-14:15:
  FN-8606 has thirteen modal identities but one geometry owner. Exercise every production class/key
  through the shared primitive so touch drag/resize, corrupt/off-screen restoration, persistence,
  and both sheet suspension breakpoints cannot silently diverge by caller identity.
  */
  it.each(FN_8606_WINDOW_IDENTITIES)("keeps %s touch-moveable, resizable, clamped, and persisted", (_component, windowKey) => {
    const geometryKey = `floating-window:${windowKey}`;
    localStorage.setItem(geometryKey, JSON.stringify({
      size: { width: 99999, height: 99999 },
      position: { x: 99999, y: -99999 },
    }));

    const { unmount } = render(
      <FloatingWindow
        windowKey={windowKey}
        title={windowKey}
        ariaLabel={`${windowKey} dialog`}
        onClose={() => {}}
        hideHeader
        dragHandleSelector=".migration-drag-handle"
        className={`floating-window--${windowKey}`}
        defaultSize={{ width: 500, height: 400 }}
        minSize={{ width: 360, height: 280 }}
        persistGeometryKey={geometryKey}
        suspendGeometryPersistenceOnMobile
        suspendGeometryPersistenceOnShortViewport
      >
        <div className="migration-drag-handle">Drag {windowKey}</div>
      </FloatingWindow>,
    );

    const panel = expectFloatingWindowStructure(windowKey);
    expect(screen.getByTestId(`floating-window-overlay-${windowKey}`)).toHaveAttribute("aria-label", `${windowKey} dialog`);
    expect(Number.parseInt(panel.style.left, 10)).toBeGreaterThanOrEqual(16);
    expect(Number.parseInt(panel.style.top, 10)).toBeGreaterThanOrEqual(16);

    dragWithTouch(screen.getByText(`Drag ${windowKey}`));
    resizeWithTouch(screen.getByTestId("floating-window-resize-se"));
    const persisted = JSON.parse(localStorage.getItem(geometryKey) ?? "{}");
    expect(persisted.position.x).toBeGreaterThanOrEqual(16);
    expect(persisted.position.y).toBeGreaterThanOrEqual(16);
    expect(persisted.size.width).toBeLessThanOrEqual(window.innerWidth - 32);
    expect(persisted.size.height).toBeLessThanOrEqual(window.innerHeight - 32);
    unmount();
  });

  it.each(FN_8606_WINDOW_IDENTITIES)("rejects corrupt persisted geometry for %s", (_component, windowKey) => {
    const geometryKey = `floating-window:${windowKey}`;
    localStorage.setItem(geometryKey, "not-json");
    render(
      <FloatingWindow
        windowKey={windowKey}
        title={windowKey}
        onClose={() => {}}
        defaultSize={{ width: 500, height: 400 }}
        persistGeometryKey={geometryKey}
      >
        <div>corrupt geometry fallback</div>
      </FloatingWindow>,
    );
    const panel = screen.getByTestId(`floating-window-${windowKey}`);
    expect(Number.parseInt(panel.style.width, 10)).toBe(500);
  });

  it.each(FN_8606_WINDOW_IDENTITIES)("wires %s to its accessible shared-window identity", (component, windowKey) => {
    const source = readAppFile(`components/${component}`);
    expect(source).toContain(`windowKey=\"${windowKey}\"`);
    expect(source).toContain(`className=\"floating-window--${windowKey}\"`);
    expect(source).toContain(`persistGeometryKey=\"floating-window:${windowKey}\"`);
    expect(source).toContain("ariaLabel=");
    expect(source).toContain("suspendGeometryPersistenceOnMobile");
    expect(source).toContain("suspendGeometryPersistenceOnShortViewport");
  });

  it.each(["phone", "short viewport"] as const)("suspends all FN-8606 geometry keys in %s sheet mode", (mode) => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: mode === "phone" ? query === "(max-width: 767.98px)" : query === "(max-height: 480px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    for (const [, windowKey] of FN_8606_WINDOW_IDENTITIES) {
      const geometryKey = `floating-window:${windowKey}`;
      const { unmount } = render(
        <FloatingWindow
          windowKey={windowKey}
          title={windowKey}
          ariaLabel={`${windowKey} dialog`}
          onClose={() => {}}
          hideHeader
          dragHandleSelector=".migration-drag-handle"
          className={`floating-window--${windowKey}`}
          persistGeometryKey={geometryKey}
          suspendGeometryPersistenceOnMobile
          suspendGeometryPersistenceOnShortViewport
        >
          <div className="migration-drag-handle">Drag {windowKey}</div>
        </FloatingWindow>,
      );
      expect(localStorage.getItem(geometryKey)).toBeNull();
      expect(screen.getByTestId(`floating-window-${windowKey}`)).toBeInTheDocument();
      expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();
      unmount();
    }

    const sheetBlock = mediaBlockFor(floatingWindowCss, "(max-width: 767.98px), (max-height: 480px)");
    for (const [, windowKey] of FN_8606_WINDOW_IDENTITIES) {
      expect(sheetBlock).toContain(`.floating-window--${windowKey}`);
    }
  });

  it("makes only the mobile chat floating window full-screen", () => {
    const mobileBlock = floatingWindowCss.match(/@media\s*\(max-width:\s*767\.98px\),\s*\(max-height:\s*480px\)\s*\{[\s\S]*?\.floating-window--chat \.chat-view\s*\{[\s\S]*?\n\}/)?.[0];

    expect(mobileBlock).toContain(".floating-window--chat");
    expect(mobileBlock).toContain("width: 100vw !important;");
    expect(mobileBlock).toContain("height: 100dvh !important;");
    expect(mobileBlock).toContain(".floating-window--chat .floating-window__resize-handle");
    expect(mediaBlockFor(floatingWindowCss, "(min-width: 769px) and (max-width: 1024px)")).not.toContain(".floating-window--chat");
  });
});
