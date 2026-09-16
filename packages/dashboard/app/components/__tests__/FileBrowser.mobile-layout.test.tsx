import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FileNode } from "../../api";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowser } from "../FileBrowser";
import { FileBrowserModal } from "../FileBrowserModal";
import { MainContentDrawer } from "../dashboard/MainContent";
import { DockFilesView } from "../DockFilesView";
import { FilesView } from "../FilesView";
import { SettingsModal } from "../SettingsModal";

/*
FN-462 symptom verification. "The files run off screen and I cannot scroll to select them" was reported three times:
FN-427 bounded only the standalone FileBrowserModal drawer window, FN-445 bounded only the Files destination inside
`.mobile-drawer__body`. Both were green and the symptom returned, because the invariant was never declared for the
COMPONENT — so every remaining host (the Files page rendered without a drawer, and the three Settings pickers) still
had an unbounded chain, and the phone header stacked four rows that left the list almost no height.

Each case mounts the PRODUCTION composition of one host with the real stylesheet injected, then walks the resolved
ancestor chain from `.file-browser-list` up to that host's panel and asserts: exactly ONE vertical scroll owner (the
list), `min-height: 0` on every intermediate box, and vertical panning left available all the way up.
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

vi.mock("../../hooks/useWorkspaceFileEditor", () => ({
  useWorkspaceFileEditor: () => ({
    content: "",
    setContent: vi.fn(),
    originalContent: "",
    loading: false,
    saving: false,
    error: null,
    save: vi.fn().mockResolvedValue(undefined),
    hasChanges: false,
    mtime: "2026-01-15T10:30:00Z",
  }),
}));

vi.mock("../../hooks/useWorkspaces", () => ({
  useWorkspaces: () => ({ projectName: "fusion", workspaces: [], loading: false, error: null }),
}));

vi.mock("../../hooks/useViewportMode", () => {
  const mode = () => (window.innerWidth <= 768 ? "mobile" : "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    isFullScreenSheetViewport: () => false,
    isShortViewport: () => false,
    getViewportMode: mode,
    isMobileViewport: () => mode() === "mobile",
    isTabletTouchViewport: (value?: string) => value === "tablet",
    useViewportMode: mode,
  };
});

const { searchFiles } = vi.hoisted(() => ({ searchFiles: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    searchFiles,
    fetchSettings: vi.fn(async () => ({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15000, autoMerge: true })),
    fetchSettingsByScope: vi.fn(async () => ({ global: {}, project: {} })),
    fetchCustomProviders: vi.fn(async () => ({ providers: [] })),
    fetchMemoryFiles: vi.fn(async () => ({ files: [] })),
    fetchGlobalConcurrency: vi.fn(async () => ({ maxConcurrentRuns: 4 })),
    fetchDashboardHealth: vi.fn(async () => ({})),
  });
});

vi.mock("../../hooks/useWorktrunkInstallStatus", () => ({
  useWorktrunkInstallStatus: () => ({ status: "missing", requestInstall: vi.fn(), requesting: false }),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOpen: false, keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 }),
}));

vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));

const longListing: FileNode[] = Array.from({ length: 40 }, (_, index) => ({
  name: `file-${String(index).padStart(2, "0")}.ts`,
  type: "file" as const,
  size: 1024,
  mtime: "2026-01-15T10:30:00Z",
}));

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

/*
 * jsdom does not expand the `overflow` shorthand into `overflow-y`, so reading `overflowY` alone reports `visible`
 * for a box that really scrolls (`.modal-body { overflow-y: auto }` is a longhand, `.mobile-drawer__body
 * { overflow: auto }` is not) and would turn the single-scroll-owner gate into a no-op.
 */
function verticalOverflow(node: HTMLElement): string {
  const style = getComputedStyle(node);
  if (style.overflowY && style.overflowY !== "visible") return style.overflowY;
  return style.overflow || "visible";
}

function describeNode(node: HTMLElement): string {
  return `${node.tagName.toLowerCase()}.${Array.from(node.classList).join(".")}`;
}

/** Every box from a leaf up to (and including) the host panel identified by `stopSelector`. */
function ancestorChain(leafSelector: string, stopSelector: string): HTMLElement[] {
  const leaf = document.querySelector<HTMLElement>(leafSelector);
  if (!leaf) throw new Error(`missing leaf for ${leafSelector}`);
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = leaf;
  while (node && node !== document.body) {
    chain.push(node);
    if (node.matches(stopSelector)) return chain;
    node = node.parentElement;
  }
  throw new Error(`chain from ${leafSelector} never reached ${stopSelector}`);
}

/** The shared invariant, asserted on a real resolved chain rather than on CSS text. */
function expectSingleBoundedScrollOwner(leafSelector: string, stopSelector: string) {
  const chain = ancestorChain(leafSelector, stopSelector);

  const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
  expect(scrollers.map(describeNode)).toEqual([describeNode(chain[0])]);
  expect(chain[0].classList.contains("file-browser-list")).toBe(true);

  const unbounded = chain
    .filter((node) => getComputedStyle(node).minHeight !== "0px")
    .map((node) => `${describeNode(node)} -> ${getComputedStyle(node).minHeight || "<unset>"}`);
  expect(unbounded).toEqual([]);

  /*
  FN-479 : `min-height: 0` ne borne RIEN sur un élément flex qui ne rétrécit pas. `.view-sidebar__panel` héritait
  `flex: none` de `ViewSidebar.css` et prenait donc la hauteur de son CONTENU (3719px mesurés dans Chromium pour un
  parent de 731px), ce qui laissait `.file-browser-list` avec `clientHeight === scrollHeight`. La boucle ci-dessus
  restait verte pendant ce temps : elle ne lisait que `min-height`. Chaque boîte intermédiaire de la chaîne doit donc
  aussi être réellement réductible.
  */
  const nonShrinking = chain
    .slice(1)
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.flexShrink === "0" || style.flex === "none" || /^0 0 /.test(style.flex ?? "");
    })
    .map((node) => `${describeNode(node)} -> ${getComputedStyle(node).flex || getComputedStyle(node).flexShrink}`);
  expect(nonShrinking).toEqual([]);

  for (const node of chain) {
    const touchAction = getComputedStyle(node).touchAction;
    if (!touchAction) continue;
    expect(`${describeNode(node)}:${touchAction}`).toMatch(/:(auto|manipulation|pan-y|pan-x pan-y|pan-y pan-x)$/);
  }
}

function renderFileBrowserModal() {
  return render(<FileBrowserModal initialWorkspace="project" isOpen onClose={vi.fn()} />);
}

function renderDrawerFilesPage() {
  return render(
    <MainContentDrawer taskView="files" open title="Files" onClose={vi.fn()}>
      <FilesView projectId="project-1" openFile={vi.fn()} />
    </MainContentDrawer>,
  );
}

function renderInlineFilesPage() {
  return render(<FilesView projectId="project-1" openFile={vi.fn()} />);
}

describe("FileBrowser phone layout (FN-462)", () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    browserState.value = {
      entries: longListing,
      currentPath: ".",
      setPath: vi.fn(),
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    styleEl.remove();
    setDesktop();
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe("every phone host resolves one bounded scroll owner", () => {
    it("(a) bounds the FileBrowserModal window in drawer presentation", () => {
      setPhone({ drawers: true });
      renderFileBrowserModal();
      expect(screen.getByText("file-39.ts")).toBeInTheDocument();

      expectSingleBoundedScrollOwner(".file-browser-list", ".modal.file-browser-modal");
    });

    it("(b) bounds the FileBrowserModal full-screen sheet without the drawer opt-in", () => {
      setPhone({ drawers: false });
      renderFileBrowserModal();

      expectSingleBoundedScrollOwner(".file-browser-list", ".modal.file-browser-modal");
    });

    it("(c) bounds the Files destination hosted by the main mobile drawer", () => {
      setPhone({ drawers: true });
      renderDrawerFilesPage();

      expectSingleBoundedScrollOwner(".file-browser-list", ".mobile-drawer__panel");
    });

    /*
     * Host E is the "select" host of the report: all three Settings pickers (ignored overlap path, worktrees
     * directory, file to copy) render the shared browser inside the SAME `.settings-overlap-path-picker-body`, which
     * as a `.modal-body` scrolled against the list while the browser itself was bounded by nothing.
     */
    /*
     * FN-479 extends host E from one picker to all THREE. They share `.settings-overlap-path-picker-body`, but each is
     * reached by its own production trigger and its own section, so a single sampled picker could not prove the other
     * two still resolve a bounded chain.
     */
    it.each([
      ["worktrees" as const, "Browse file to copy into new worktrees"],
      ["worktrees" as const, "Browse worktrees directory"],
      ["scheduling" as const, "Browse path for ignored overlap entry 1"],
    ])("(e) bounds the Settings workspace picker « %s / %s » and keeps its actions inside the panel", async (section, triggerLabel) => {
      setPhone({ drawers: false });
      render(<SettingsModal onClose={vi.fn()} addToast={vi.fn()} initialSection={section} />);

      await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument(), { timeout: 3000 });

      /*
       * The whole production stylesheet is injected, and jsdom resolves `display` without layout, so role queries
       * treat parts of the Settings body as hidden. The trigger itself is production markup; click it directly.
       */
      const browse = await waitFor(
        () => {
          const node = document.querySelector<HTMLButtonElement>(`button[aria-label="${triggerLabel}"]`);
          if (!node) throw new Error(`picker trigger not rendered: ${triggerLabel}`);
          return node;
        },
        { timeout: 3000 },
      );
      fireEvent.click(browse);
      await waitFor(() => expect(document.querySelector(".settings-overlap-path-picker-body")).not.toBeNull(), { timeout: 3000 });
      expect(document.querySelector(".settings-overlap-path-picker-body .file-browser-list")!.textContent).toContain("file-39.ts");

      expectSingleBoundedScrollOwner(".file-browser-list", ".settings-overlap-path-picker-modal");

      const picker = document.querySelector<HTMLElement>(".settings-overlap-path-picker-modal")!;
      const actions = picker.querySelector<HTMLElement>(".modal-actions")!;
      expect(actions).toBeInTheDocument();
      expect(getComputedStyle(actions).getPropertyValue("flex")).toBe("0 0 auto");
      expect(getComputedStyle(picker.querySelector<HTMLElement>(".settings-overlap-path-picker-body")!).getPropertyValue("max-height")).toBe("none");
    });

    it("(d) bounds the Files page rendered inline, without any drawer", () => {
      setPhone({ drawers: false });
      renderInlineFilesPage();
      expect(screen.getByText("file-39.ts")).toBeInTheDocument();

      expectSingleBoundedScrollOwner(".file-browser-list", ".files-view");
    });
  });

  describe("(h) pre-hydration arm", () => {
    /*
     * Before hydration publishes `data-viewport-mode`, the phone is only identifiable by the media query — which jsdom
     * does not evaluate for computed style, so this arm is pinned on the declaration itself (the same shape
     * ViewLayout.css uses).
     */
    it("declares the same invariant for a phone-width document with no viewport-mode attribute", () => {
      const css = loadAllAppCss();

      for (const selector of [
        "html:not([data-viewport-mode]) .file-browser {",
        "html:not([data-viewport-mode]) .file-browser .file-browser-list {",
        "html:not([data-viewport-mode]) .files-view .dock-files-view",
      ]) {
        expect(css).toContain(selector);
      }
    });
  });

  describe("data states keep a single scroll owner", () => {
    it.each([
      ["(i) an empty directory", () => { browserState.value = { ...browserState.value, entries: [] }; }, ".file-browser-empty"],
      ["a long populated directory", () => { browserState.value = { ...browserState.value, entries: longListing }; }, ".file-browser-list"],
    ])("%s", (_label, seed, leafSelector) => {
      seed();
      setPhone({ drawers: false });
      renderInlineFilesPage();

      const chain = ancestorChain(leafSelector, ".files-view");
      const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
      expect(scrollers.length).toBeLessThanOrEqual(1);
      for (const scroller of scrollers) expect(scroller.classList.contains("file-browser-list")).toBe(true);
    });

    it.each([
      ["(j) loading", () => { browserState.value = { ...browserState.value, loading: true }; }, ".file-browser-loading"],
      ["(j) failed", () => { browserState.value = { ...browserState.value, error: "Workspace unavailable" }; }, ".file-browser-error"],
    ])("%s replaces the browser without creating a second scroller", (_label, seed, leafSelector) => {
      seed();
      setPhone({ drawers: false });
      renderInlineFilesPage();

      const chain = ancestorChain(leafSelector, ".files-view");
      expect(chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)))).toEqual([]);
    });

    it("(k) keeps the search-results filler inside the single list scroller", async () => {
      searchFiles.mockResolvedValue({ files: longListing.map((entry) => ({ name: entry.name, path: `src/${entry.name}` })) });
      setPhone({ drawers: false });
      renderInlineFilesPage();

      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "file" } });
      await waitFor(() => expect(document.querySelector(".file-browser-search-results")).not.toBeNull(), { timeout: 2000 });

      const chain = ancestorChain(".file-browser-search-results", ".files-view");
      const scrollers = chain.filter((node) => ["auto", "scroll"].includes(verticalOverflow(node)));
      expect(scrollers.map(describeNode)).toEqual([describeNode(chain[1])]);
      expect(chain[1].classList.contains("file-browser-list")).toBe(true);
    });
  });

  describe("compact phone chrome", () => {
    it("caps the header at three touch rows and keeps the list growing", () => {
      setPhone({ drawers: false });
      renderInlineFilesPage();

      const header = document.querySelector<HTMLElement>(".file-browser-header")!;
      const search = document.querySelector<HTMLElement>(".file-browser-search")!;
      const actions = document.querySelector<HTMLElement>(".file-browser-header-actions")!;
      const sortControls = document.querySelector<HTMLElement>(".file-browser-sort-controls")!;

      expect(getComputedStyle(header).flexGrow).toBe("0");
      // Rows 2 and 3 each claim a full line; sort no longer takes a fourth one of its own.
      expect(getComputedStyle(search).flexBasis).toBe("100%");
      expect(getComputedStyle(actions).flexBasis).toBe("100%");
      expect(getComputedStyle(actions).flexWrap).toBe("nowrap");
      expect(getComputedStyle(sortControls).flexBasis).toBe("auto");
      expect(getComputedStyle(sortControls).width).not.toBe("100%");
    });

    it("(l) ellipsizes a very long file name instead of clipping or overflowing", () => {
      browserState.value = {
        ...browserState.value,
        entries: [{ name: `${"deeply-nested-configuration-file-name-".repeat(6)}.ts`, type: "file" as const, size: 10, mtime: "2026-01-15T10:30:00Z" }],
      };
      setPhone({ drawers: false });
      renderInlineFilesPage();

      const name = document.querySelector<HTMLElement>(".file-node-name")!;
      expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(name).whiteSpace).toBe("nowrap");
      expect(verticalOverflow(document.querySelector<HTMLElement>(".file-browser-list")!)).toBe("auto");
      expect(getComputedStyle(document.querySelector<HTMLElement>(".file-browser-list")!).overflowX).toBe("hidden");
    });

    it("gives every file row a full touch target height", () => {
      setPhone({ drawers: false });
      renderInlineFilesPage();

      const row = document.querySelector<HTMLElement>(".file-node")!;
      expect(getComputedStyle(row).minBlockSize || getComputedStyle(row).getPropertyValue("min-block-size")).toBe("var(--touch-target-min-size)");
    });

    it("(m/n) keeps every control named with the project file controls shown", () => {
      setPhone({ drawers: false });
      renderInlineFilesPage();

      expect(screen.getByRole("button", { name: "Create new file" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create new folder" })).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "Search project files" })).toBeInTheDocument();
      expect(screen.getByLabelText("Sort by")).toBeInTheDocument();

      // The label is hidden by clipping, never removed, so the <select> keeps its accessible name.
      const sortLabel = document.querySelector<HTMLElement>(".file-browser-sort-label")!;
      expect(getComputedStyle(sortLabel).display).not.toBe("none");
      expect(getComputedStyle(sortLabel).clipPath).toBe("inset(50%)");

      // No empty shell: the create buttons still carry their (clipped) label text.
      for (const label of document.querySelectorAll(".file-browser-create-button__label")) {
        expect(label.textContent).not.toBe("");
      }
    });

    it("(m) keeps the compact picker chrome named when project file controls are hidden", () => {
      setPhone({ drawers: false });
      render(
        <FileBrowser
          entries={longListing}
          currentPath="."
          onSelectFile={vi.fn()}
          onNavigate={vi.fn()}
          loading={false}
          error={null}
          workspace="project"
          projectId="project-1"
        />,
      );

      expect(screen.queryByRole("button", { name: "Create new file" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /New/ })).toBeInTheDocument();
      expect(screen.getByLabelText("Sort by")).toBeInTheDocument();
      expect(document.querySelector(".file-browser-search")).toBeNull();
    });
  });

  describe("negative controls", () => {
    it("(f) leaves the desktop dock host geometry untouched", () => {
      setDesktop();
      render(<DockFilesView projectId="project-1" openFile={vi.fn()} />);

      const browser = document.querySelector<HTMLElement>(".file-browser")!;
      expect(getComputedStyle(browser).height).toBe("100%");
      // Desktop keeps the wrapping action row, the ordinary row height and no safe-area list inset.
      expect(getComputedStyle(document.querySelector<HTMLElement>(".file-browser-header-actions")!).flexWrap).toBe("wrap");
      expect(getComputedStyle(document.querySelector<HTMLElement>(".file-node")!).getPropertyValue("min-block-size")).not.toBe("var(--touch-target-min-size)");
      expect(getComputedStyle(document.querySelector<HTMLElement>(".file-browser-list")!).getPropertyValue("padding-block-end")).not.toContain("safe-area-inset-bottom");
    });

    it("(g) does not leak the phone rules into a narrow desktop file window", () => {
      setDesktop();
      const { container } = render(
        <div className="modal file-browser-modal file-browser-modal--narrow">
          <FileBrowser
            entries={longListing}
            currentPath="."
            onSelectFile={vi.fn()}
            onNavigate={vi.fn()}
            loading={false}
            error={null}
            workspace="project"
            projectId="project-1"
          />
        </div>,
      );

      const sortControls = container.querySelector<HTMLElement>(".file-browser-sort-controls")!;
      // jsdom keeps `flex` as a shorthand, so read the declaration the narrow-window rule actually writes.
      expect(getComputedStyle(sortControls).getPropertyValue("flex")).toBe("1 1 calc(var(--space-xl) * 5)");
      expect(getComputedStyle(container.querySelector<HTMLElement>(".file-browser-sort-label")!).clipPath).not.toBe("inset(50%)");
    });
  });
});
