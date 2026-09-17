import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileNode } from "../../api";
import { loadAllAppCss } from "../../test/cssFixture";
import { MainContentDrawer } from "../dashboard/MainContent";
import { DockFilesView } from "../DockFilesView";
import { FilesView } from "../FilesView";

/*
FN-445 symptom verification. On a phone the Files destination is rendered inside the MAIN mobile drawer
(`mobile-drawer-main-content`), whose body scrolls. The hosted page already owns a bounded internal scroller
(`.file-browser-list`), so the drawer body and the list competed for the same gesture and the end of a long
directory stayed unreachable. FN-427 only ever fixed the FileBrowserModal window, never this host.

These cases mount the PRODUCTION composition (MainContentDrawer -> FilesView -> DockFilesView -> FileBrowser)
and pin the invariant on both a deterministic CSS-text floor and the real gate: computed style resolved over the
whole ancestor chain, per
docs/solutions/ui-bugs/mobile-touch-action-ancestor-intersection-defeats-leaf-scroll.md.
*/

const { browserState } = vi.hoisted(() => ({
  browserState: {
    value: {
      entries: [] as FileNode[],
      currentPath: ".",
      setPath: vi.fn(),
      loading: false,
      error: null as string | null,
      refresh: vi.fn(),
    },
  },
}));

vi.mock("../../hooks/useWorkspaceFileBrowser", () => ({
  useWorkspaceFileBrowser: () => browserState.value,
}));

const { searchFiles } = vi.hoisted(() => ({ searchFiles: vi.fn() }));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  searchFiles,
}));

const DRAWER_BODY_PREFIX = 'html[data-mobile-drawers="true"][data-viewport-mode="mobile"] .mobile-drawer__body';

const longListing: FileNode[] = Array.from({ length: 40 }, (_, index) => ({
  name: `file-${String(index).padStart(2, "0")}.ts`,
  type: "file" as const,
  size: 1024,
  mtime: "2026-01-15T10:30:00Z",
}));

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  if (index === -1) return "";
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function setPhone({ drawers }: { drawers: boolean }) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
  document.documentElement.dataset.viewportMode = "mobile";
  if (drawers) document.documentElement.dataset.mobileDrawers = "true";
  else delete document.documentElement.dataset.mobileDrawers;
}

function setDesktop() {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  delete document.documentElement.dataset.viewportMode;
  delete document.documentElement.dataset.mobileDrawers;
}

function renderFilesDrawer(taskView: "files" | "memory" = "files") {
  return render(
    <MainContentDrawer taskView={taskView} open title="Files" onClose={vi.fn()}>
      {taskView === "files"
        ? <FilesView projectId="project-1" openFile={vi.fn()} />
        : <div className="memory-view">ordinary long view</div>}
    </MainContentDrawer>,
  );
}

/** Every box from the scrollable leaf up to (and including) the drawer panel. */
function ancestorChain(leafSelector: string): HTMLElement[] {
  const leaf = document.querySelector<HTMLElement>(leafSelector);
  if (!leaf) throw new Error(`missing leaf for ${leafSelector}`);
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = leaf;
  while (node) {
    chain.push(node);
    if (node.classList.contains("mobile-drawer__panel")) break;
    node = node.parentElement;
  }
  return chain;
}

function dispatchTouch(target: EventTarget, type: "touchstart" | "touchmove", x: number, y: number, identifier = 7): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  const touch = { identifier, clientX: x, clientY: y, target } as Touch;
  Object.defineProperties(event, {
    touches: { value: [touch] },
    changedTouches: { value: [touch] },
  });
  target.dispatchEvent(event);
  return event;
}

function describeNode(node: HTMLElement): string {
  return `${node.tagName.toLowerCase()}.${Array.from(node.classList).join(".")}`;
}

/*
 * jsdom does not expand the `overflow` shorthand into `overflow-y`, so reading `overflowY` alone reports
 * `visible` for a box that really scrolls (`.mobile-drawer__body { overflow: auto }`) and would silently turn
 * the single-scroll-owner gate into a no-op. Resolve the longhand first, then fall back to the shorthand.
 */
function verticalOverflow(node: HTMLElement): string {
  const style = getComputedStyle(node);
  if (style.overflowY && style.overflowY !== "visible") return style.overflowY;
  return style.overflow || "visible";
}

describe("Files destination inside the main mobile drawer (FN-445)", () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    browserState.value = { ...browserState.value, entries: longListing, loading: false, error: null };
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    styleEl.remove();
    setDesktop();
    vi.clearAllMocks();
  });

  describe("drawer host declares scroll ownership", () => {
    it("marks the Files drawer panel as content-owned scroll", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const panel = document.querySelector<HTMLElement>(".mobile-drawer__panel");
      expect(panel).not.toBeNull();
      expect(panel!.classList.contains("mobile-drawer__panel--content-scroll")).toBe(true);
    });

    it("keeps an ordinary destination on the scrollable drawer body", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("memory");

      const panel = document.querySelector<HTMLElement>(".mobile-drawer__panel");
      expect(panel!.classList.contains("mobile-drawer__panel--content-scroll")).toBe(false);
      expect(verticalOverflow(document.querySelector<HTMLElement>(".mobile-drawer__body")!)).toBe("auto");
    });
  });

  describe("bounded geometry rules", () => {
    it("declares min-height: 0 on every box between the drawer body and the list", () => {
      const css = loadAllAppCss();
      for (const selector of [
        `${DRAWER_BODY_PREFIX} .files-view`,
        `${DRAWER_BODY_PREFIX} .files-view .view-layout__body`,
        `${DRAWER_BODY_PREFIX} .files-view .view-layout__content`,
        `${DRAWER_BODY_PREFIX} .files-view .dock-files-view`,
        `${DRAWER_BODY_PREFIX} .files-view .file-browser`,
      ]) {
        expect(css).toContain(selector);
      }
      const shared = ruleBody(css, `${DRAWER_BODY_PREFIX} .files-view .file-browser {`);
      expect(shared).toContain("min-height: 0");
      expect(shared).toContain("min-block-size: 0");
    });

    it("makes the file list the single bounded scroll owner of the drawer-hosted page", () => {
      const css = loadAllAppCss();
      const body = ruleBody(css, `${DRAWER_BODY_PREFIX} .files-view .file-browser-list`);

      expect(body).toContain("flex: 1 1 auto");
      expect(body).toContain("min-height: 0");
      expect(body).toContain("overflow-y: auto");
      expect(body).toContain("overscroll-behavior: contain");
    });

    it("keeps the file browser header as non-growing chrome", () => {
      const css = loadAllAppCss();
      expect(ruleBody(css, `${DRAWER_BODY_PREFIX} .files-view .file-browser-header`)).toContain("flex: 0 0 auto");
    });
  });

  describe("rule scope", () => {
    it("gates every added rule behind the phone drawer opt-in", () => {
      const css = loadAllAppCss();
      const added = css.split("\n").filter((line) => line.includes(".mobile-drawer__body .files-view"));

      expect(added.length).toBeGreaterThan(0);
      for (const line of added) {
        expect(line.trimStart().startsWith(DRAWER_BODY_PREFIX.slice(0, DRAWER_BODY_PREFIX.indexOf(" ")))).toBe(true);
        expect(line).toContain('[data-mobile-drawers="true"]');
        expect(line).toContain('[data-viewport-mode="mobile"]');
      }
    });

    /*
     * `.dock-files-view` is the probe because it carries only the LOGICAL `min-block-size: 0` in base CSS, which jsdom
     * does not resolve into `min-height`. `.files-view` cannot be used: `.mobile-drawer__body > *` already gives it a
     * physical `min-height: 0` on every host, so it could never prove attribute gating.
     *
     * FN-462 update: this case used to assert the OPPOSITE — that a phone WITHOUT the drawer opt-in stayed unbounded,
     * which was the FN-445 scope, not a desirable behaviour. That gap is exactly why the operator reported the symptom
     * a third time, so the page is now bounded on every phone and only desktop keeps the old geometry.
     */
    it("bounds the page on a phone without the drawer opt-in too", () => {
      setPhone({ drawers: false });
      renderFilesDrawer("files");

      expect(getComputedStyle(document.querySelector<HTMLElement>(".dock-files-view")!).minHeight).toBe("0px");
    });

    it("leaves the desktop page untouched", () => {
      setDesktop();
      renderFilesDrawer("files");

      expect(getComputedStyle(document.querySelector<HTMLElement>(".dock-files-view")!).minHeight).not.toBe("0px");
    });

    it("leaves the optional dock host untouched on a phone", () => {
      setPhone({ drawers: true });
      render(<DockFilesView projectId="project-1" openFile={vi.fn()} />);

      const dock = document.querySelector<HTMLElement>(".dock-files-view")!;
      expect(dock.closest(".mobile-drawer__body")).toBeNull();
      expect(getComputedStyle(dock).minHeight).not.toBe("0px");
    });
  });

  /*
   * Every data state the browser can render is a distinct overflow shape: the list can hold rows, a filler
   * (`.file-browser-search-results` carries `min-height: 100%`), or a centred message, and loading/error replace
   * `.file-browser` entirely. None of them may reintroduce a second scroll owner inside the drawer.
   */
  describe("data states", () => {
    it.each([
      ["a long populated directory", () => { browserState.value = { ...browserState.value, entries: longListing }; }, ".file-browser-list"],
      ["an empty directory", () => { browserState.value = { ...browserState.value, entries: [] }; }, ".file-browser-empty"],
      ["a loading directory", () => { browserState.value = { ...browserState.value, loading: true }; }, ".file-browser-loading"],
      ["a failed directory", () => { browserState.value = { ...browserState.value, error: "Workspace unavailable" }; }, ".file-browser-error"],
    ])("keeps a single scroll owner for %s", (_label, seed, leafSelector) => {
      seed();
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const chain = ancestorChain(leafSelector);
      const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
      expect(scrollers.length).toBeLessThanOrEqual(1);
      for (const scroller of scrollers) expect(scroller.classList.contains("file-browser-list")).toBe(true);
      expect(verticalOverflow(document.querySelector<HTMLElement>(".mobile-drawer__body")!)).toBe("hidden");
    });

    it("keeps the search results filler inside the single list scroller", async () => {
      searchFiles.mockResolvedValue({ files: longListing.map((entry) => ({ name: entry.name, path: `src/${entry.name}` })) });
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "file" } });
      await waitFor(() => expect(document.querySelector(".file-browser-search-results")).not.toBeNull(), { timeout: 2000 });

      const chain = ancestorChain(".file-browser-search-results");
      const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
      expect(scrollers.map(describeNode)).toEqual([describeNode(chain[1])]);
      expect(chain[1].classList.contains("file-browser-list")).toBe(true);
    });
  });

  /*
   * `useDrawerDismissGesture` is attached to the WHOLE panel. These cases lock the existing behaviour so a future
   * drawer change cannot re-create the block: they never modify the hook.
   */
  describe("drawer dismissal gesture does not capture list scrolling", () => {
    it("still claims a downward drag from the top of the list (harness control)", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const row = screen.getByText("file-05.ts");
      dispatchTouch(row, "touchstart", 0, 100);
      expect(dispatchTouch(document, "touchmove", 0, 240).defaultPrevented).toBe(true);
    });

    it("leaves an upward drag on a file row native", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const row = screen.getByText("file-05.ts");
      dispatchTouch(row, "touchstart", 0, 300);
      const move = dispatchTouch(document, "touchmove", 0, 180);

      expect(move.defaultPrevented).toBe(false);
      expect(document.querySelector<HTMLElement>(".mobile-drawer__panel")!.style.transform).toBe("");
    });

    it("does not claim the pointer once the list is already scrolled", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const list = document.querySelector<HTMLElement>(".file-browser-list")!;
      Object.defineProperty(list, "scrollTop", { configurable: true, value: 120 });

      const row = screen.getByText("file-05.ts");
      dispatchTouch(row, "touchstart", 0, 200);
      const move = dispatchTouch(document, "touchmove", 0, 340);

      expect(move.defaultPrevented).toBe(false);
      expect(document.querySelector<HTMLElement>(".mobile-drawer__panel")!.style.transform).toBe("");
    });
  });

  describe("resolved ancestor chain", () => {
    it("resolves exactly one vertical scroll owner from the list up to the drawer panel", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");
      expect(screen.getByText("file-39.ts")).toBeInTheDocument();

      const chain = ancestorChain(".file-browser-list");
      expect(chain.at(-1)!.classList.contains("mobile-drawer__panel")).toBe(true);

      const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
      expect(scrollers.map(describeNode)).toEqual([describeNode(chain[0])]);
      expect(chain[0].classList.contains("file-browser-list")).toBe(true);
    });

    it("resolves min-height: 0 on every intermediate box of the chain", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      const chain = ancestorChain(".file-browser-list");
      const offenders = chain
        .filter((node) => getComputedStyle(node).minHeight !== "0px")
        .map((node) => `${describeNode(node)} -> ${getComputedStyle(node).minHeight || "<unset>"}`);
      expect(offenders).toEqual([]);
    });

    it("leaves vertical panning available on every ancestor of the list", () => {
      setPhone({ drawers: true });
      renderFilesDrawer("files");

      for (const node of ancestorChain(".file-browser-list")) {
        const touchAction = getComputedStyle(node).touchAction;
        if (!touchAction) continue;
        expect(`${describeNode(node)}:${touchAction}`).toMatch(/:(auto|manipulation|pan-y|pan-x pan-y|pan-y pan-x)$/);
      }
    });
  });
});
