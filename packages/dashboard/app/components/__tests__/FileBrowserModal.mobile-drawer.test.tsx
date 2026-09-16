import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileBrowserModal } from "../FileBrowserModal";
import { loadAllAppCss } from "../../test/cssFixture";
import * as workspaceBrowserHook from "../../hooks/useWorkspaceFileBrowser";
import * as workspaceEditorHook from "../../hooks/useWorkspaceFileEditor";
import * as workspacesHook from "../../hooks/useWorkspaces";

vi.mock("../../hooks/useWorkspaceFileBrowser");
vi.mock("../../hooks/useWorkspaceFileEditor");
vi.mock("../../hooks/useWorkspaces");
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

const mockUseWorkspaceFileBrowser = vi.mocked(workspaceBrowserHook.useWorkspaceFileBrowser);
const mockUseWorkspaceFileEditor = vi.mocked(workspaceEditorHook.useWorkspaceFileEditor);
const mockUseWorkspaces = vi.mocked(workspacesHook.useWorkspaces);

/*
FNXC:FileBrowser 2026-09-15-16:33:
FN-427 symptom verification. On a phone the Files surface was sized on the VIEWPORT (100dvh) while its drawer host is
only `var(--mobile-drawer-block-size)` tall, so the file list ran past the visible area and its last entries were
unreachable, with the drawer body scrolling as a second competing scroller. These cases pin the drawer-scoped geometry
(surface bounded to its panel, drawer body not scrolling, `.file-browser-list` as the single bounded scroll owner) and
the list navigation contract: opening a file always yields a reachable "Back to file list" return.
*/

const DRAWER_PREFIX = 'html[data-mobile-drawers="true"][data-viewport-mode="mobile"] .floating-window--file-browser.floating-window--mobile-drawer';

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  if (index === -1) return "";
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

const longListing = Array.from({ length: 40 }, (_, index) => ({
  name: `file-${String(index).padStart(2, "0")}.ts`,
  type: "file" as const,
  size: 1024,
  mtime: "2024-01-01",
}));

describe("FileBrowserModal phone drawer layout", () => {
  const mockOnClose = vi.fn();
  const mockSetPath = vi.fn();
  const mockRefresh = vi.fn();

  const browserState = {
    entries: longListing,
    currentPath: ".",
    setPath: mockSetPath,
    loading: false,
    error: null,
    refresh: mockRefresh,
  };

  const editorState = {
    content: "console.log('hello');",
    setContent: vi.fn(),
    originalContent: "console.log('hello');",
    loading: false,
    saving: false,
    error: null,
    save: vi.fn().mockResolvedValue(undefined),
    hasChanges: false,
    mtime: "2024-01-01",
  };

  function renderPhoneFileBrowser({ drawers, initialFile }: { drawers: boolean; initialFile?: string }) {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    document.documentElement.dataset.viewportMode = "mobile";
    if (drawers) document.documentElement.dataset.mobileDrawers = "true";
    else delete document.documentElement.dataset.mobileDrawers;
    return render(
      <FileBrowserModal
        initialWorkspace="project"
        isOpen={true}
        onClose={mockOnClose}
        initialFile={initialFile}
      />,
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockUseWorkspaceFileBrowser.mockReturnValue(browserState);
    mockUseWorkspaceFileEditor.mockReturnValue(editorState);
    mockUseWorkspaces.mockReturnValue({
      projectName: "kb",
      workspaces: [],
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    delete document.documentElement.dataset.mobileDrawers;
    delete document.documentElement.dataset.viewportMode;
    localStorage.clear();
  });

  describe("drawer geometry rules", () => {
    it("bounds the Files surface to its drawer panel instead of the viewport", () => {
      const css = loadAllAppCss();
      const body = ruleBody(css, `${DRAWER_PREFIX} .modal.file-browser-modal`);

      expect(body).toContain("height: 100%");
      expect(body).toContain("max-height: 100%");
      expect(body).toContain("min-height: 0");
      expect(body).not.toContain("100dvh");
    });

    it("stops the drawer body from becoming a second scroller", () => {
      const css = loadAllAppCss();
      const body = ruleBody(css, `${DRAWER_PREFIX} .floating-window__body`);

      expect(body).toContain("overflow: hidden");
      expect(body).toContain("min-height: 0");
    });

    it("keeps min-height: 0 on every box between the drawer panel and the list", () => {
      const css = loadAllAppCss();
      for (const selector of [
        `${DRAWER_PREFIX} .file-browser-body`,
        `${DRAWER_PREFIX} .file-browser-sidebar`,
        `${DRAWER_PREFIX} .view-sidebar__panel`,
        `${DRAWER_PREFIX} .file-browser-sidebar__panel`,
        `${DRAWER_PREFIX} .file-browser-content`,
        `${DRAWER_PREFIX} .file-browser`,
      ]) {
        expect(css).toContain(selector);
      }
      // All six share one declaration block, which is the block that follows the last selector in the group.
      expect(ruleBody(css, `${DRAWER_PREFIX} .file-browser {`)).toContain("min-height: 0");
    });

    /*
    FN-479 : ce groupe de sélecteurs était vert alors que la liste ne défilait toujours pas. `min-height: 0` n'a aucun
    effet sur un élément flex qui ne rétrécit pas, et `ViewSidebar.css` donne au panneau du rail `flex: none` : il
    prenait donc la hauteur de son contenu. La déclaration manquante est la réductibilité elle-même, portée par une
    règle de base (aucun point de rupture : le défaut existait aussi sur tablette et ordinateur) et écrite en forme
    parent > enfant pour battre `.view-sidebar__panel` par spécificité plutôt que par ordre d'injection.
    */
    it("rend le panneau du rail réductible, ce que min-height: 0 ne pouvait pas faire", () => {
      const css = loadAllAppCss();
      const body = ruleBody(css, ".file-browser-sidebar > .file-browser-sidebar__panel");

      expect(body).toContain("flex: 1 1 auto");
      expect(body).not.toContain("flex: none");
    });

    it("makes the file list the single bounded scroll owner in drawer presentation", () => {
      const css = loadAllAppCss();
      const body = ruleBody(css, `${DRAWER_PREFIX} .file-browser-list`);

      expect(body).toContain("overflow-y: auto");
      expect(body).toContain("min-height: 0");
      expect(body).toContain("flex: 1 1 auto");
    });

    it("keeps the full-screen phone sheet rules for a phone without the drawer opt-in", () => {
      const css = loadAllAppCss();
      // The viewport-sized sheet remains correct when the window is not a drawer at all.
      expect(css).toMatch(/\.modal\.file-browser-modal\s*\{[^}]*height:\s*100dvh/);
    });
  });

  describe("list to file navigation", () => {
    it.each([
      ["in drawer presentation", true],
      ["on a phone without the drawer opt-in", false],
    ])("returns from an open file to the file list %s", async (_label, drawers) => {
      renderPhoneFileBrowser({ drawers });
      fireEvent(window, new Event("resize"));

      expect(screen.getByText("file-00.ts")).toBeInTheDocument();
      expect(screen.getByText("file-39.ts")).toBeInTheDocument();

      fireEvent.click(screen.getByText("file-03.ts"));

      const back = await screen.findByLabelText("Back to file list");
      expect(document.querySelector(".file-browser-content.mobile.active")).not.toBeNull();

      fireEvent.click(back);

      await waitFor(() => {
        expect(document.querySelector(".file-browser-sidebar.mobile.active")).not.toBeNull();
      });
      expect(document.querySelector(".file-browser-content.mobile.active")).toBeNull();
    });

    it("renders the empty list without a return to a file that is not open", () => {
      mockUseWorkspaceFileBrowser.mockReturnValue({ ...browserState, entries: [] });
      renderPhoneFileBrowser({ drawers: true });
      fireEvent(window, new Event("resize"));

      expect(document.querySelector(".file-browser-sidebar.mobile.active")).not.toBeNull();
      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();
    });

    it("keeps the direct file view free of a return to a list it never had", async () => {
      renderPhoneFileBrowser({ drawers: true, initialFile: "src/index.ts" });
      fireEvent(window, new Event("resize"));

      await waitFor(() => {
        expect(document.querySelector(".file-browser-sidebar")).toBeNull();
      });
      expect(screen.queryByLabelText("Back to file list")).not.toBeInTheDocument();
      // The drawer shell still owns dismissal through its shared handle.
      expect(document.querySelectorAll(".view-drawer__handle-target").length).toBeGreaterThan(0);
    });
  });
});
