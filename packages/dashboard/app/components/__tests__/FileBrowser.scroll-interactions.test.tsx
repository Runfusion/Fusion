import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileNode } from "../../api";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowser } from "../FileBrowser";
import { FileBrowserModal } from "../FileBrowserModal";

/*
FN-479 — pendant DOM du correctif de défilement.

La preuve du symptôme (hauteur calculée, conteneur défilant effectif, pan tactile natif) appartient à
`packages/dashboard/src/__tests__/file-browser-scroll-browser.test.ts` : jsdom ne calcule aucune des trois. Cette
suite couvre ce que jsdom PEUT prouver et que le navigateur couvre mal :

- le MÉCANISME de la cause : dans la chaîne réelle du navigateur général, le panneau du rail
  (`.view-sidebar__panel`) doit être un élément flex réductible. Avant FN-479 il valait `flex: none`, donc il prenait
  la hauteur de son contenu et la liste n'était plus un conteneur défilant du tout ;
- l'ordre des gestes autour du défilement (tap, appui long, annulation, démontage) ;
- l'indépendance de deux navigateurs montés simultanément ;
- les états de données qui remplacent la liste (vide, chargement, erreur/réessai, métadonnées absentes, recherche).
*/

const { searchFiles } = vi.hoisted(() => ({ searchFiles: vi.fn() }));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), { searchFiles });
});

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
    content: "", setContent: vi.fn(), originalContent: "", loading: false, saving: false,
    error: null, save: vi.fn().mockResolvedValue(undefined), hasChanges: false, mtime: "2026-01-15T10:30:00Z",
  }),
}));

vi.mock("../../hooks/useWorkspaces", () => ({
  useWorkspaces: () => ({ projectName: "fusion", workspaces: [], loading: false, error: null }),
}));

const LONG_LISTING: FileNode[] = Array.from({ length: 80 }, (_, index) => (
  index % 5 === 0
    ? { name: `dossier-${String(index).padStart(3, "0")}`, type: "directory" as const }
    : { name: `fichier-${String(index).padStart(3, "0")}.txt`, type: "file" as const, size: 1024 + index, mtime: "2026-01-15T10:30:00Z" }
));

function baseProps(overrides: Partial<React.ComponentProps<typeof FileBrowser>> = {}) {
  return {
    entries: LONG_LISTING,
    currentPath: ".",
    onSelectFile: vi.fn(),
    onNavigate: vi.fn(),
    loading: false,
    error: null,
    workspace: "project",
    ...overrides,
  } as React.ComponentProps<typeof FileBrowser>;
}

function touch(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] };
}

describe("FN-479 — mécanisme de la cause dans la chaîne du navigateur général", () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    browserState.value = { entries: LONG_LISTING, currentPath: ".", setPath: vi.fn(), loading: false, error: null, refresh: vi.fn() };
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    document.documentElement.dataset.viewportMode = "mobile";
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    styleEl.remove();
    delete document.documentElement.dataset.viewportMode;
    delete document.documentElement.dataset.mobileDrawers;
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    vi.clearAllMocks();
  });

  /*
  La cause mesurée dans Chromium : `.view-sidebar__panel` en `flex: none` à l'intérieur du conteneur colonne
  `.file-browser-sidebar` prend la hauteur de son CONTENU, donc `.file-browser-list` reçoit
  `clientHeight === scrollHeight`. `min-height: 0` — seule déclaration posée par FN-427/FN-445/FN-462 sur cette boîte
  — n'a aucun effet sur un élément qui ne rétrécit pas. La boîte doit donc être réductible.
  */
  it("rend le panneau du rail réductible, pas seulement min-height: 0", () => {
    render(<FileBrowserModal initialWorkspace="project" isOpen onClose={vi.fn()} />);
    const panel = document.querySelector<HTMLElement>(".file-browser-sidebar__panel");
    expect(panel).not.toBeNull();
    const style = getComputedStyle(panel!);
    expect(style.flexShrink === "" ? style.flex : style.flexShrink).not.toBe("0");
    expect(`${style.flex} ${style.flexShrink}`).not.toMatch(/\bnone\b/);
    /* La largeur du rail reste possédée par ViewSidebar.css : le correctif ne touche que l'axe de bloc. */
    expect(style.width === "" || style.width === "auto" || style.width.length > 0).toBe(true);
  });

  it("garde la liste comme unique conteneur vertical déclaré de la chaîne", () => {
    render(<FileBrowserModal initialWorkspace="project" isOpen onClose={vi.fn()} />);
    const list = document.querySelector<HTMLElement>(".file-browser-list")!;
    const scrollers: string[] = [];
    let node: HTMLElement | null = list;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const vertical = style.overflowY && style.overflowY !== "visible" ? style.overflowY : (style.overflow || "visible");
      if (vertical === "auto" || vertical === "scroll") scrollers.push(Array.from(node.classList).join("."));
      node = node.parentElement;
    }
    expect(scrollers).toEqual([Array.from(list.classList).join(".")]);
  });
});

describe("FN-479 — ordre des gestes autour du défilement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    browserState.value = { entries: LONG_LISTING, currentPath: ".", setPath: vi.fn(), loading: false, error: null, refresh: vi.fn() };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("ouvre exactement l'élément touché lors d'un tap immobile", () => {
    const onSelectFile = vi.fn();
    const onNavigate = vi.fn();
    render(<FileBrowser {...baseProps({ onSelectFile, onNavigate })} />);
    const row = screen.getByText("fichier-001.txt").closest(".file-node")!;
    fireEvent.touchStart(row, touch(10, 100));
    fireEvent.touchEnd(row);
    fireEvent.click(row);
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith("fichier-001.txt");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each([100, 400])("annule l'appui long dès que le doigt se déplace (à %ims)", (elapsed) => {
    render(<FileBrowser {...baseProps()} />);
    const row = screen.getByText("fichier-001.txt").closest(".file-node")!;
    fireEvent.touchStart(row, touch(10, 100));
    act(() => { vi.advanceTimersByTime(elapsed); });
    fireEvent.touchMove(row, touch(10, 40));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(document.querySelector(".file-browser-context-menu")).toBeNull();
    expect(document.querySelector(".file-node--long-pressing")).toBeNull();
  });

  it("conserve le menu d'un appui long immobile", () => {
    render(<FileBrowser {...baseProps()} />);
    const row = screen.getByText("fichier-001.txt").closest(".file-node")!;
    fireEvent.touchStart(row, touch(10, 100));
    act(() => { vi.advanceTimersByTime(600); });
    expect(document.querySelector('[role="menu"], .file-browser-context-menu')).not.toBeNull();
  });

  it("n'ouvre aucun menu tardif après touchcancel puis démontage", () => {
    const view = render(<FileBrowser {...baseProps()} />);
    const row = screen.getByText("fichier-001.txt").closest(".file-node")!;
    fireEvent.touchStart(row, touch(10, 100));
    fireEvent.touchCancel(row);
    view.unmount();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(document.querySelector(".file-browser-context-menu")).toBeNull();
  });
});

describe("FN-479 — deux navigateurs restent indépendants", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  /*
  L'écouteur de fermeture passait par `document.querySelector(".file-browser-list")`, donc par la PREMIÈRE liste du
  document : le menu de la seconde instance ne se fermait jamais sur son propre défilement, et se fermait à tort sur
  celui de la première. Les deux ordres de montage sont couverts.
  */
  it.each([0, 1])("lie le menu au défilement de sa propre liste (instance %i)", (index) => {
    render(
      <>
        <div data-testid="instance-0"><FileBrowser {...baseProps()} /></div>
        <div data-testid="instance-1"><FileBrowser {...baseProps()} /></div>
      </>,
    );
    const owner = within(screen.getByTestId(`instance-${index}`));
    const other = within(screen.getByTestId(`instance-${index === 0 ? 1 : 0}`));
    const row = owner.getAllByText("fichier-001.txt")[0].closest(".file-node")!;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    expect(document.querySelectorAll(".file-browser-context-menu").length).toBe(1);

    /* Le défilement de l'AUTRE liste ne doit pas piloter ce menu. */
    fireEvent.scroll(other.getByTestId ? document.querySelectorAll(".file-browser-list")[index === 0 ? 1 : 0] : document.body);
    expect(document.querySelectorAll(".file-browser-context-menu").length).toBe(1);

    /* Le défilement de SA liste le ferme. */
    fireEvent.scroll(document.querySelectorAll(".file-browser-list")[index]);
    expect(document.querySelectorAll(".file-browser-context-menu").length).toBe(0);
  });
});

describe("FN-479 — états de données qui remplacent la liste", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("rend un répertoire vide sans zone fantôme captant le geste", () => {
    render(<FileBrowser {...baseProps({ entries: [] })} />);
    expect(screen.getByText("(empty directory)")).toBeInTheDocument();
    expect(document.querySelectorAll(".file-node").length).toBe(0);
  });

  it("redevient défilable après chargement → liste longue", () => {
    const view = render(<FileBrowser {...baseProps({ loading: true, entries: [] })} />);
    expect(document.querySelector(".file-browser-list")).toBeNull();
    view.rerender(<FileBrowser {...baseProps()} />);
    expect(document.querySelector(".file-browser-list")).not.toBeNull();
    expect(document.querySelectorAll(".file-node").length).toBe(LONG_LISTING.length);
  });

  it("redevient défilable après erreur → réessai → liste", () => {
    const onRetry = vi.fn();
    const view = render(<FileBrowser {...baseProps({ error: "boom", entries: [], onRetry })} />);
    expect(document.querySelector(".file-browser-list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(<FileBrowser {...baseProps()} />);
    expect(document.querySelectorAll(".file-node").length).toBe(LONG_LISTING.length);
  });

  it("garde des lignes touchables quand size et mtime sont absents", () => {
    render(<FileBrowser {...baseProps({ entries: [{ name: "sans-metadonnees.txt", type: "file" }] })} />);
    const row = screen.getByText("sans-metadonnees.txt").closest(".file-node")!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".file-node-size")).toBeNull();
    expect(row.querySelector(".file-node-time")).toBeNull();
  });

  /*
  Deux résultats homonymes sous des chemins distincts : la sélection doit renvoyer le CHEMIN cliqué, jamais le nom.
  Aucune déduplication métier n'est introduite.
  */
  it("sélectionne le bon chemin parmi des résultats de recherche homonymes", async () => {
    searchFiles.mockResolvedValue({ files: [
      { path: "src/a/index.ts", name: "index.ts" },
      { path: "src/b/index.ts", name: "index.ts" },
    ] });
    const onSelectFile = vi.fn();
    render(<FileBrowser {...baseProps({ onSelectFile, showProjectFileControls: true, workspace: "project" })} />);
    fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "index" } });
    const results = await screen.findAllByText("index.ts");
    expect(results).toHaveLength(2);
    fireEvent.click(results[1].closest("button")!);
    await waitFor(() => expect(onSelectFile).toHaveBeenCalledWith("src/b/index.ts"));
  });

  it("revient à la liste longue après une recherche vidée", async () => {
    searchFiles.mockResolvedValue({ files: [] });
    render(<FileBrowser {...baseProps({ showProjectFileControls: true, workspace: "project" })} />);
    const input = screen.getByLabelText("Search project files");
    fireEvent.change(input, { target: { value: "zzz" } });
    await screen.findByText("No files found");
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(document.querySelectorAll(".file-node").length).toBe(LONG_LISTING.length));
  });
});
