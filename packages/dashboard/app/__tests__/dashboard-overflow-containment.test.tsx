import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";
import { getViewportMode, isMobileViewport, MOBILE_MEDIA_QUERY } from "../hooks/useViewportMode";

type BreakpointCase = {
  name: "mobile" | "tablet";
  width: number;
  height: number;
};

const BREAKPOINTS: BreakpointCase[] = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 834, height: 1112 },
];

const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";
const TABLET_MEDIA_QUERY = "(min-width: 769px) and (max-width: 1024px)";
const originalScreen = window.screen;

function extractMediaBlocks(content: string, pattern: RegExp): string {
  const blocks: string[] = [];

  for (const match of content.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    let index = start;
    let depth = 1;
    while (index < content.length && depth > 0) {
      if (content[index] === "{") depth++;
      if (content[index] === "}") depth--;
      index++;
    }
    expect(depth).toBe(0);
    blocks.push(content.slice(start, index - 1));
  }

  expect(blocks.length).toBeGreaterThan(0);
  return blocks.join("\n");
}

function ruleBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "gs"))].map((match) => match[0]);
}

function ruleBlock(css: string, selector: string): string {
  const blocks = ruleBlocks(css, selector);
  expect(blocks.length, `missing CSS rule for ${selector}`).toBeGreaterThan(0);
  return blocks[0];
}

function declarationValue(rule: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = rule.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? null;
}

function defineMetric(element: Element, property: "clientWidth" | "scrollWidth", value: number) {
  Object.defineProperty(element, property, { configurable: true, value });
}

function defineRect(element: Element, rect: Partial<DOMRectReadOnly>) {
  const fullRect = {
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    width: (rect.right ?? 0) - (rect.left ?? 0),
    height: (rect.bottom ?? 0) - (rect.top ?? 0),
    top: rect.top ?? 0,
    right: rect.right ?? 0,
    bottom: rect.bottom ?? 0,
    left: rect.left ?? 0,
    toJSON: () => ({}),
  } satisfies DOMRectReadOnly;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(fullRect);
}

function installViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: {
      ...originalScreen,
      width,
      height,
      availWidth: width,
      availHeight: height,
    } as Screen,
  });

  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      query === MOBILE_WIDTH_MEDIA_QUERY ? width <= 768 :
      query === MOBILE_HEIGHT_MEDIA_QUERY ? height <= 480 :
      query === MOBILE_MEDIA_QUERY ? width <= 768 || height <= 480 :
      query === TABLET_MEDIA_QUERY ? width >= 769 && width <= 1024 :
      false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));

  defineMetric(document.documentElement, "clientWidth", width);
  defineMetric(document.documentElement, "scrollWidth", width);
  defineMetric(document.body, "clientWidth", width);
  defineMetric(document.body, "scrollWidth", width);
}

function assertNoDocumentHorizontalOverflow(label: string) {
  expect(
    document.documentElement.scrollWidth,
    `${label}: documentElement should not horizontally overflow`,
  ).toBeLessThanOrEqual(document.documentElement.clientWidth + 1);
  expect(document.body.scrollWidth, `${label}: body should not horizontally overflow`).toBeLessThanOrEqual(
    document.body.clientWidth + 1,
  );
}

function assertContained(element: Element, label: string) {
  expect(element.scrollWidth, label).toBeLessThanOrEqual(element.clientWidth + 1);
}

function assertInViewport(element: Element, viewport: BreakpointCase, label: string) {
  const rect = element.getBoundingClientRect();
  expect(rect.left, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(rect.right, `${label}: right edge`).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.top, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(rect.bottom, `${label}: bottom edge`).toBeLessThanOrEqual(viewport.height + 1);
}

function BoardFixture({ populated }: { populated: boolean }) {
  const columns = populated ? ["Triage", "Todo", "In Progress", "In Review", "Done", "Archived"] : ["Empty"];
  return (
    <main data-testid="board-surface" className="board-shell">
      <section className="board" data-testid={populated ? "board-populated" : "board-empty"}>
        {columns.map((column) => (
          <article className="column" key={column}>
            <header className="column-header">
              <h2>{column}</h2>
            </header>
            <div className="column-body">
              {populated ? (
                <div className="task-card">Wide task title withaverylongunbrokenidentifierthatmuststayinsidecard</div>
              ) : (
                <p className="empty">No tasks</p>
              )}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function TaskDetailFixture({ populated }: { populated: boolean }) {
  return (
    <div className="modal-overlay" data-testid={populated ? "detail-populated-overlay" : "detail-empty-overlay"}>
      <section className="modal task-detail-modal" data-testid={populated ? "detail-populated" : "detail-empty"}>
        <header className="modal-header">
          <h2>{populated ? "Long task detail" : "Empty task detail"}</h2>
          <button className="modal-close" aria-label="Close task detail">×</button>
        </header>
        <div className="detail-body" data-testid={populated ? "detail-populated-body" : "detail-empty-body"}>
          {populated ? (
            <div className="markdown-body">
              <p>Long content pressure withaverylongunbrokenwordthatmustnotescape-the-detail-body.</p>
              <pre><code>very-wide-command --with --many --arguments --that --scrolls --internally</code></pre>
            </div>
          ) : (
            <p>No task selected.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function WorkflowFixture({ simple }: { simple: boolean }) {
  return (
    <div className="modal-overlay" data-testid={simple ? "simple-workflow-overlay" : "workflow-overlay"}>
      <section className="modal wf-editor-modal" data-testid={simple ? "simple-workflow" : "workflow-editor"}>
        <header className="wf-editor-header">
          <h2>{simple ? "Simple workflow editor" : "Workflow editor"}</h2>
          <button className="wf-editor-close" aria-label="Close workflow editor">×</button>
        </header>
        <div className={`wf-editor-body ${simple ? "wf-editor-body--simple-layout" : "wf-editor-body--list-stage"}`}>
          <aside className="wf-editor-sidebar">
            <button className="wf-editor-new">New workflow</button>
            <button className="wf-editor-import">Import workflow</button>
          </aside>
          <div className="wf-editor-canvas-wrap">
            <div className="wf-editor-toolbar">
              <button className="wf-editor-action">Validate</button>
              <button className="wf-editor-save">Save</button>
            </div>
            <div className="wf-editor-canvas">Canvas</div>
          </div>
          <div className="wf-mobile-shell">
            <nav className="wf-mobile-tabs" aria-label="Workflow editor sections">
              <button className="wf-mobile-tab wf-mobile-tab--active">Add</button>
              <button className="wf-mobile-tab">Actions</button>
            </nav>
            <div className="wf-mobile-panel">
              <div className="wf-mobile-actions">
                <button className="wf-editor-action">Validate</button>
                <button className="wf-editor-save">Save workflow</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ActivityLogFixture() {
  return (
    <div className="modal-overlay" data-testid="activity-log-overlay">
      <section className="modal modal-lg activity-log-modal" data-testid="activity-log-modal">
        <header className="modal-header activity-log-header">
          <h2 className="activity-log-title">Activity Log</h2>
          <div className="activity-log-actions">
            <label className="activity-log-filter">
              Type
              <select className="activity-log-filter-select" aria-label="Type filter"><option>All</option></select>
            </label>
            <button className="activity-log-refresh" aria-label="Refresh activity log">↻</button>
            <button className="activity-log-clear" aria-label="Clear activity log">Clear</button>
          </div>
          <button className="modal-close" aria-label="Close activity log">×</button>
        </header>
        <div className="activity-log-content"><p className="activity-log-empty">No activity yet.</p></div>
      </section>
    </div>
  );
}

function setSurfaceMetrics(surface: Element, viewport: BreakpointCase, options: { internalScroller?: boolean } = {}) {
  defineMetric(surface, "clientWidth", viewport.width);
  defineMetric(surface, "scrollWidth", viewport.width);
  if (options.internalScroller) {
    defineMetric(surface, "scrollWidth", viewport.width * 2);
  }
  defineRect(surface, { left: 0, top: 0, right: viewport.width, bottom: Math.min(viewport.height, 720) });
}

function setActionMetrics(container: Element, viewport: BreakpointCase) {
  const actions = within(container as HTMLElement).queryAllByRole("button");
  actions.forEach((action, index) => {
    defineRect(action, {
      left: Math.max(0, viewport.width - 56 - index * 72),
      right: Math.max(44, viewport.width - 16 - index * 72),
      top: 16 + index * 4,
      bottom: 60 + index * 4,
    });
  });
}

/**
 * Surface Enumeration coverage for FN-6385:
 * - CSS stylesheet rules via loadAllAppCss + rendered DOM fixtures with mocked viewport metrics.
 * - Mobile max-width: 768px, tablet 769px–1024px, and landscape-phone max-height branch.
 * - Empty + populated board/detail states; wide content pressure is represented by fixture content and metrics.
 * - Shared seams: useViewportMode helpers, modal/detail shell classes, loadAllAppCss aggregation.
 * - Board/kanban, task-detail modal, workflow editor, simple workflow editor, and Activity Log modal.
 * - Primary controls are asserted inside viewport; intended internal scrollers remain overflow-x:auto usable.
 */
describe("dashboard overflow containment shared mobile/tablet net (FN-6385)", () => {
  const css = loadAllAppCss();
  const baseCss = loadAllAppCssBaseOnly();
  const mobileCss = extractMediaBlocks(css, /@media\s*\([^)]*max-width:\s*768px[^)]*\)[^{]*\{/g);
  const tabletCss = extractMediaBlocks(css, /@media\s*\(\s*min-width:\s*769px\s*\)\s*and\s*\(\s*max-width:\s*1024px\s*\)\s*\{/g);

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "screen", { configurable: true, value: originalScreen });
  });

  it("keeps the shared CSS contract on the root/body, modal shell, and intended horizontal scrollers", () => {
    const rootBlock = ruleBlock(baseCss, "html,\nbody");
    const appRootBlock = ruleBlock(baseCss, "#root");
    const mobileRootBlock = ruleBlock(mobileCss, "html,\n  body");
    const mobileOverlayBlock = ruleBlock(
      mobileCss,
      ".modal-overlay:not(.confirm-dialog-overlay),\n  .agent-detail-overlay,\n  .agent-dialog-overlay,\n  .workflow-output-modal-overlay",
    );
    const detailBodyBlock = ruleBlock(baseCss, ".detail-body");
    const boardBaseBlock = ruleBlock(baseCss, ".board");
    const boardMobileBlock = ruleBlock(mobileCss, ".board");
    const boardTabletBlock = ruleBlock(tabletCss, ".board");
    const activityTabletBlock = ruleBlock(tabletCss, ".activity-log-modal");

    expect(rootBlock).toContain("overflow: hidden;");
    expect(appRootBlock).toContain("overflow: hidden;");
    expect(mobileRootBlock).toContain("overflow-x: hidden;");
    expect(mobileRootBlock).toContain("overscroll-behavior-x: none;");
    expect(mobileOverlayBlock).toContain("overflow-x: hidden;");

    expect(detailBodyBlock).toContain("overflow-x: hidden;");
    expect(detailBodyBlock).toContain("overflow-y: auto;");

    expect(declarationValue(boardBaseBlock, "overflow-x")).toBe("auto");
    expect(declarationValue(boardMobileBlock, "overflow-x")).toBe("auto");
    expect(declarationValue(boardTabletBlock, "overflow-x")).toBe("auto");
    expect(boardMobileBlock).toContain("touch-action: pan-x pan-y;");
    expect(activityTabletBlock).toContain("max-width: calc(100vw - var(--space-2xl));");
  });

  it("keeps workflow editor and simple editor CSS from owning page-level horizontal scroll", () => {
    const mobileBodyBlock = ruleBlock(mobileCss, ".wf-editor-body");
    const mobileListSidebarBlock = ruleBlock(mobileCss, ".wf-editor-body--list-stage .wf-editor-sidebar");
    const mobileCanvasBlocks = ruleBlocks(mobileCss, ".wf-editor-canvas");
    const mobileCanvasBlock = mobileCanvasBlocks.find((block) => block.includes("max-width: 100%;")) ?? "";
    expect(mobileCanvasBlock, "missing mobile canvas containment rule").not.toBe("");
    const mobileShellBlock = ruleBlock(mobileCss, ".wf-mobile-shell");
    const simpleShellBlock = ruleBlock(baseCss, ".wf-editor-body--simple-layout .wf-mobile-shell");
    const simpleTabsBlock = ruleBlock(baseCss, ".wf-mobile-tabs");

    expect(mobileBodyBlock).toContain("min-width: 0;");
    expect(mobileBodyBlock).toContain("overflow-x: hidden;");
    expect(mobileListSidebarBlock).toContain("min-width: 0;");
    expect(mobileListSidebarBlock).toContain("overflow-x: hidden;");
    expect(mobileCanvasBlock).toContain("max-width: 100%;");
    expect(mobileCanvasBlock).toContain("overflow: hidden;");
    expect(mobileShellBlock).toContain("overflow: hidden;");
    expect(simpleShellBlock).toContain("overflow: hidden;");
    expect(simpleTabsBlock).toContain("overflow-x: auto;");
  });

  it("resolves viewport helper modes for mobile, tablet, and landscape-phone breakpoints", () => {
    installViewport(375, 812);
    expect(isMobileViewport()).toBe(true);
    expect(getViewportMode()).toBe("mobile");

    installViewport(834, 1112);
    expect(isMobileViewport()).toBe(false);
    expect(getViewportMode()).toBe("tablet");

    installViewport(844, 390);
    expect(isMobileViewport()).toBe(true);
    expect(getViewportMode()).toBe("mobile");
  });

  it.each(BREAKPOINTS)("keeps board/kanban overflow contained at $name width", (viewport) => {
    installViewport(viewport.width, viewport.height);
    render(
      <>
        <BoardFixture populated={false} />
        <BoardFixture populated />
      </>,
    );

    for (const board of [screen.getByTestId("board-empty"), screen.getByTestId("board-populated")]) {
      setSurfaceMetrics(board, viewport, { internalScroller: true });
      expect(board.scrollWidth).toBeGreaterThan(board.clientWidth);
      expect(ruleBlock(viewport.name === "mobile" ? mobileCss : tabletCss, ".board")).toContain("overflow-x: auto;");
    }

    assertNoDocumentHorizontalOverflow(`${viewport.name} board root`);
  });

  it.each(BREAKPOINTS)("keeps task-detail modal shell contained with empty and long content at $name width", (viewport) => {
    installViewport(viewport.width, viewport.height);
    render(
      <>
        <TaskDetailFixture populated={false} />
        <TaskDetailFixture populated />
      </>,
    );

    for (const modal of [screen.getByTestId("detail-empty"), screen.getByTestId("detail-populated")]) {
      setSurfaceMetrics(modal, viewport);
      assertContained(modal, `${viewport.name} task detail modal`);
      setActionMetrics(modal, viewport);
      assertInViewport(within(modal).getByRole("button", { name: /close task detail/i }), viewport, "task detail close");
    }

    for (const body of [screen.getByTestId("detail-empty-body"), screen.getByTestId("detail-populated-body")]) {
      defineMetric(body, "clientWidth", viewport.width);
      defineMetric(body, "scrollWidth", viewport.width);
      assertContained(body, `${viewport.name} detail body`);
    }

    assertNoDocumentHorizontalOverflow(`${viewport.name} task detail root`);
  });

  it.each(BREAKPOINTS)("keeps workflow and simple-editor controls reachable at $name width", (viewport) => {
    installViewport(viewport.width, viewport.height);
    render(
      <>
        <WorkflowFixture simple={false} />
        <WorkflowFixture simple />
      </>,
    );

    for (const surface of [screen.getByTestId("workflow-editor"), screen.getByTestId("simple-workflow")]) {
      setSurfaceMetrics(surface, viewport);
      assertContained(surface, `${viewport.name} workflow surface`);
      setActionMetrics(surface, viewport);
      for (const saveButton of within(surface).getAllByRole("button", { name: /save/i })) {
        assertInViewport(saveButton, viewport, "workflow save action");
      }
      assertInViewport(within(surface).getByRole("button", { name: /close workflow editor/i }), viewport, "workflow close action");
    }

    const tabStrip = screen.getAllByRole("navigation", { name: /workflow editor sections/i })[1];
    defineMetric(tabStrip, "clientWidth", viewport.width);
    defineMetric(tabStrip, "scrollWidth", viewport.width * 2);
    expect(ruleBlock(baseCss, ".wf-mobile-tabs")).toContain("overflow-x: auto;");
    expect(tabStrip.scrollWidth).toBeGreaterThan(tabStrip.clientWidth);

    assertNoDocumentHorizontalOverflow(`${viewport.name} workflow root`);
  });

  it.each(BREAKPOINTS)("keeps Activity Log modal actions reachable at $name width", (viewport) => {
    installViewport(viewport.width, viewport.height);
    render(<ActivityLogFixture />);

    const modal = screen.getByTestId("activity-log-modal");
    setSurfaceMetrics(modal, viewport);
    setActionMetrics(modal, viewport);

    assertContained(modal, `${viewport.name} activity log modal`);
    assertInViewport(screen.getByRole("button", { name: /refresh activity log/i }), viewport, "activity log refresh");
    assertInViewport(screen.getByRole("button", { name: /clear activity log/i }), viewport, "activity log clear");
    assertInViewport(screen.getByRole("button", { name: /close activity log/i }), viewport, "activity log close");
    assertNoDocumentHorizontalOverflow(`${viewport.name} activity log root`);
  });
});
