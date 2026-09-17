/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 results panel, mounted as the PRODUCTION component.
 *
 * jsdom returns a zero rectangle for everything and ships an inert `ResizeObserver`, so a test that
 * merely renders the panel proves no geometry at all. Real rectangles and real observer callbacks are
 * injected here, and the assertions read what the component actually applied — that is the only way
 * the 1.5-card reserve, the card-equal width, and the "cards never shrink" rule are genuinely covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskSearchResultsPopover } from "../TaskSearchResultsPopover";
import { readAppFile } from "../../test/cssFixture";
import { TASK_SEARCH_PEEK_RATIO, TASK_SEARCH_VIEWPORT_MARGIN } from "../../utils/taskSearchGeometry";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));
vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(async () => []),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  refineTask: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-a", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));

const observerCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  constructor(private readonly callback: () => void) { observerCallbacks.push(() => this.callback()); }
  observe() { /* geometry is driven explicitly by the test */ }
  unobserve() { /* no-op */ }
  disconnect() { /* no-op */ }
}

/** The measured rectangle for each selector family, keyed by class. */
interface RectPlan {
  field: { top: number; bottom: number; left: number; width: number; height: number };
  boardCardWidth: number;
  resultHeights: number[];
  gap: number;
  viewport: { width: number; height: number };
}

let plan: RectPlan;

/*
Captured ONCE at module scope. Re-reading `window.getComputedStyle` inside `installGeometry` would
capture the previous spy when a test installs geometry twice, and the delegation would recurse.
*/
const originalGetComputedStyle = window.getComputedStyle.bind(window);

function installGeometry(next: RectPlan) {
  plan = next;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: next.viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: next.viewport.height });

  Element.prototype.getBoundingClientRect = function boundingRect(this: Element): DOMRect {
    if (this.classList.contains("task-search-anchor")) {
      const { top, bottom, left, width, height } = plan.field;
      return { top, bottom, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    }
    if (this.classList.contains("task-search-result")) {
      const list = [...(this.parentElement?.querySelectorAll(".task-search-result") ?? [])];
      const height = plan.resultHeights[list.indexOf(this)] ?? 0;
      return { top: 0, bottom: height, left: 0, right: plan.boardCardWidth, width: plan.boardCardWidth, height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    if (this.classList.contains("card") && this.closest(".column-body")) {
      return { top: 0, bottom: 100, left: 0, right: plan.boardCardWidth, width: plan.boardCardWidth, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };

  vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element, pseudo?: string | null) => {
    const style = originalGetComputedStyle(element as HTMLElement, pseudo ?? undefined);
    if (element instanceof HTMLElement && element.classList.contains("task-search-results-list")) {
      return { ...style, rowGap: `${plan.gap}px`, getPropertyValue: (name: string) => style.getPropertyValue(name) } as CSSStyleDeclaration;
    }
    if (element === document.documentElement) {
      return {
        ...style,
        getPropertyValue: (name: string) => name === "--task-search-card-min-width" ? "300px" : style.getPropertyValue(name),
      } as CSSStyleDeclaration;
    }
    return style;
  }) as typeof window.getComputedStyle);
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Titre ${id}`,
    column: "todo",
    steps: [],
    dependencies: [],
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function Harness(props: Partial<Parameters<typeof TaskSearchResultsPopover>[0]> & { tasks: Task[] }) {
  const anchorRef = { current: document.querySelector<HTMLElement>(".task-search-anchor") };
  return (
    <TaskSearchResultsPopover
      anchorRef={anchorRef}
      lane="text"
      loading={false}
      aiLoading={false}
      hasMore={false}
      error={null}
      panelId="task-search-panel"
      onSelectTask={props.onSelectTask ?? (() => undefined)}
      onLoadMore={props.onLoadMore ?? (() => undefined)}
      addToast={() => undefined}
      {...props}
    />
  );
}

function renderPanel(props: Partial<Parameters<typeof TaskSearchResultsPopover>[0]> & { tasks: Task[] }) {
  const field = document.createElement("div");
  field.className = "task-search-anchor";
  document.body.appendChild(field);
  const view = render(<Harness {...props} />);
  return { ...view, field };
}

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  observerCallbacks.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as never);
  installGeometry({
    field: { top: 60, bottom: 92, left: 400, width: 220, height: 32 },
    boardCardWidth: 344,
    resultHeights: [140, 180],
    gap: 8,
    viewport: { width: 1440, height: 900 },
  });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll(".task-search-anchor").forEach((node) => node.remove());
});

describe("TaskSearchResultsPopover — sizing", () => {
  it("reserves one full card plus the gap plus half of the next before scrolling", () => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    const scroll = screen.getByTestId("task-search-results-scroll");
    expect(scroll.style.blockSize).toBe(`${140 + 8 + 180 * TASK_SEARCH_PEEK_RATIO}px`);
  });

  it("matches the width of a real board card rather than the narrow input", () => {
    // A board card is mounted so the panel has something to measure.
    const column = document.createElement("div");
    column.className = "column-body";
    const boardCard = document.createElement("div");
    boardCard.className = "card";
    column.appendChild(boardCard);
    document.body.appendChild(column);

    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    const panel = screen.getByTestId("task-search-results");
    expect(panel.style.width).toBe("344px");
    // The field is only 220px wide; using it would squash every card.
    expect(panel.style.width).not.toBe("220px");

    column.remove();
  });

  it("falls back to the shared column token when no board card is measurable (List view)", () => {
    renderPanel({ tasks: [makeTask("FN-1")] });
    expect(screen.getByTestId("task-search-results").style.width).toBe("300px");
  });

  it("derives the reserve from a single result without fabricating a second card", () => {
    installGeometry({
      field: { top: 60, bottom: 92, left: 400, width: 220, height: 32 },
      boardCardWidth: 344,
      resultHeights: [160],
      gap: 10,
      viewport: { width: 1440, height: 900 },
    });

    renderPanel({ tasks: [makeTask("FN-ONLY")] });

    expect(screen.getByTestId("task-search-results-scroll").style.blockSize).toBe(`${160 + 10 + 80}px`);
    expect(screen.getAllByTestId("task-search-result")).toHaveLength(1);
  });

  it("stays inside a short viewport instead of overflowing or shrinking cards", () => {
    installGeometry({
      field: { top: 240, bottom: 272, left: 20, width: 340, height: 32 },
      boardCardWidth: 340,
      resultHeights: [220, 220],
      gap: 8,
      viewport: { width: 390, height: 380 },
    });

    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    const scroll = screen.getByTestId("task-search-results-scroll");
    const reserved = Number.parseFloat(scroll.style.blockSize);
    expect(reserved).toBeLessThan(220 + 8 + 110);
    expect(reserved).toBeGreaterThan(0);
    // The panel flipped above the field rather than being pinned into a few pixels below it.
    expect(screen.getByTestId("task-search-results").className).toContain("task-search-results--above");
  });

  it.each([
    [390, 844],
    [768, 1024],
    [1023, 768],
    [1024, 768],
    [1440, 900],
  ])("keeps the panel inside the %ix%i viewport", (width, height) => {
    installGeometry({
      field: { top: 60, bottom: 92, left: Math.max(0, width - 260), width: 220, height: 32 },
      boardCardWidth: 344,
      resultHeights: [140, 180],
      gap: 8,
      viewport: { width, height },
    });

    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    const panel = screen.getByTestId("task-search-results");
    const left = Number.parseFloat(panel.style.left);
    const panelWidth = Number.parseFloat(panel.style.width);
    expect(left).toBeGreaterThanOrEqual(TASK_SEARCH_VIEWPORT_MARGIN);
    expect(left + panelWidth).toBeLessThanOrEqual(width);
  });

  it("re-measures when a card resizes after its content settles", () => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });
    const scroll = screen.getByTestId("task-search-results-scroll");
    expect(scroll.style.blockSize).toBe(`${140 + 8 + 90}px`);

    // A card grew (steps expanded). The reserve must follow instead of staying frozen.
    plan.resultHeights = [260, 300];
    act(() => { for (const fire of observerCallbacks) fire(); });

    expect(scroll.style.blockSize).toBe(`${260 + 8 + 150}px`);
  });

  it("re-measures when the visual viewport shrinks, as an on-screen keyboard does", () => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });
    const before = Number.parseFloat(screen.getByTestId("task-search-results-scroll").style.blockSize);

    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 260 });
      plan.viewport = { width: plan.viewport.width, height: 260 };
      fireEvent(window, new Event("resize"));
    });

    expect(Number.parseFloat(screen.getByTestId("task-search-results-scroll").style.blockSize)).toBeLessThan(before);
  });
});

describe("TaskSearchResultsPopover — content and behaviour", () => {
  it("renders real cards, not truncated suggestion rows", () => {
    const { container } = renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    expect(container.ownerDocument.querySelectorAll(".task-search-result .card")).toHaveLength(2);
    expect(container.ownerDocument.querySelector(".task-search-suggestion")).toBeNull();
    expect(container.ownerDocument.querySelector(".task-search-suggestion-title")).toBeNull();
  });

  it("owns exactly one vertical scroll surface", () => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2"), makeTask("FN-3")] });
    const panel = screen.getByTestId("task-search-results");
    const scrollers = [...panel.querySelectorAll("*")].filter((node) =>
      node.getAttribute("data-testid") === "task-search-results-scroll");
    expect(scrollers).toHaveLength(1);
  });

  it("selects the activated task exactly once", () => {
    const onSelectTask = vi.fn();
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")], onSelectTask });

    const rows = screen.getAllByTestId("task-search-result");
    fireEvent.click(within(rows[1]).getByText("FN-2"));

    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask.mock.calls[0][0].id).toBe("FN-2");
  });

  it("announces the active lane and switches its accessible name for the AI lane", () => {
    const { rerender } = renderPanel({ tasks: [makeTask("FN-1")] });
    expect(screen.getByTestId("task-search-results")).toHaveAttribute("data-lane", "text");

    rerender(<Harness tasks={[makeTask("FN-1")]} lane="ai" />);
    expect(screen.getByTestId("task-search-results")).toHaveAttribute("data-lane", "ai");
    expect(screen.getByTestId("task-search-lane-label").textContent).toMatch(/intelligente/i);
  });

  it("renders a pagination sentinel only for the text lane", () => {
    const { rerender } = renderPanel({ tasks: [makeTask("FN-1")], hasMore: true });
    expect(screen.queryByTestId("task-search-results-sentinel")).not.toBeNull();

    rerender(<Harness tasks={[makeTask("FN-1")]} lane="ai" hasMore />);
    expect(screen.queryByTestId("task-search-results-sentinel")).toBeNull();
  });

  it("shows loading, empty, and error states without pretending an error was an empty answer", () => {
    const { rerender } = renderPanel({ tasks: [], loading: true });
    expect(screen.getByTestId("task-search-results-status").textContent).toMatch(/Recherche/i);

    rerender(<Harness tasks={[]} loading={false} />);
    expect(screen.getByTestId("task-search-results-status").textContent).toMatch(/Aucune t/i);

    rerender(<Harness tasks={[]} error={{ kind: "ai", code: "AI_TASK_SEARCH_RATE_LIMIT", status: 429 }} />);
    expect(screen.getByTestId("task-search-results-status").textContent).toMatch(/Trop de recherches/i);

    rerender(<Harness tasks={[]} error={{ kind: "ai", code: "AI_TASK_SEARCH_TIMEOUT", status: 504 }} />);
    expect(screen.getByTestId("task-search-results-status").textContent).toMatch(/d\u00e9lai/i);
  });

  it("does not steal focus from the search field and lays down no backdrop", () => {
    const { field } = renderPanel({ tasks: [makeTask("FN-1")] });
    const input = document.createElement("input");
    field.appendChild(input);
    input.focus();

    const panel = screen.getByTestId("task-search-results");
    // The panel is non-modal: no backdrop element and no autofocus.
    expect(document.querySelector(".modal-overlay")).toBeNull();
    expect(document.activeElement).toBe(input);

    // Pressing inside the panel must not blur the field.
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    panel.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });

  it("leaves no card action shells behind in the panel", () => {
    renderPanel({
      tasks: [makeTask("FN-1", { column: "todo" }), makeTask("FN-2", { column: "done" })],
    });
    const panel = screen.getByTestId("task-search-results");
    expect(panel.querySelector(".task-card-context-menu-popover")).toBeNull();
    for (const card of panel.querySelectorAll(".card")) {
      expect(card).not.toHaveAttribute("aria-haspopup", "menu");
    }
  });
});

/*
FNXC:TaskSearch 2026-09-17-07:43:
FN-494 — le panneau doit être réellement défilable. Les trois défauts couverts ici sont : l'annulation
globale du `mousedown` qui supprimait le glissement de la barre de défilement native, l'absence de
confinement du geste, et la re-mesure complète du panneau déclenchée par son propre défilement.
*/
describe("TaskSearchResultsPopover — défilement (FN-494)", () => {
  it.each(["text", "ai"] as const)("(b1)/(b3) une pression dans la zone défilante n'est pas annulée — lane %s", (lane) => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")], lane });

    const scroll = screen.getByTestId("task-search-results-scroll");
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    scroll.dispatchEvent(mouseDown);

    // Le glissement natif de la barre de défilement reste possible et le panneau ne se ferme pas.
    expect(mouseDown.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("task-search-results")).not.toBeNull();
  });

  it.each(["text", "ai"] as const)("(b2)/(b3) une pression sur le chrome reste annulée — lane %s", (lane) => {
    const { container } = renderPanel({ tasks: [makeTask("FN-1")], lane });

    const header = container.ownerDocument.querySelector(".task-search-results-header");
    expect(header).not.toBeNull();
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    header?.dispatchEvent(mouseDown);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("task-search-results")).not.toBeNull();
  });

  it("(b5) ArrowDown/ArrowUp déplacent le focus entre deux cartes de résultat", () => {
    renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });

    const cards = [...document.querySelectorAll<HTMLElement>(".task-search-result .card")];
    expect(cards).toHaveLength(2);

    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);

    // Depuis la première carte, ArrowUp ne quitte pas le panneau.
    fireEvent.keyDown(cards[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(cards[0]);
  });

  it.each([
    { name: "chargement", props: { loading: true } },
    { name: "erreur", props: { error: { kind: "ai", code: "AI_TASK_SEARCH_TIMEOUT", status: 504 } } },
  ])("(b6) la zone défilante existe sans résultat — $name", ({ props }) => {
    renderPanel({ tasks: [], ...(props as Record<string, unknown>) });

    const scroll = screen.getByTestId("task-search-results-scroll");
    expect(scroll).not.toBeNull();
    expect(screen.getByTestId("task-search-results-status")).not.toBeNull();

    const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    scroll.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(false);
  });

  it("(b7) un défilement interne ne relance pas la mesure d'ancrage, un défilement extérieur si", () => {
    const { field } = renderPanel({ tasks: [makeTask("FN-1"), makeTask("FN-2")] });
    const measured = vi.spyOn(field, "getBoundingClientRect");

    const scroll = screen.getByTestId("task-search-results-scroll");
    act(() => { scroll.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(measured).not.toHaveBeenCalled();

    act(() => { fireEvent.scroll(document); });
    expect(measured.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("TaskSearchResultsPopover — garde CSS (FN-494)", () => {
  /*
  jsdom n'applique pas les feuilles de style : c'est une garde de CONSTRUCTION sur le propriétaire de
  défilement, pas une assertion sur un commentaire.
  */
  it("(b4) `.task-search-results-scroll` déclare overflow-y, overscroll-behavior et touch-action", () => {
    const css = readAppFile("components/TaskSearchResultsPopover.css");
    const blocks = [...css.matchAll(/\.task-search-results-scroll\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const base = blocks[0];
    expect(base).toMatch(/overflow-y:\s*auto/);
    expect(base).toMatch(/overscroll-behavior:\s*contain/);
    expect(base).toMatch(/touch-action:\s*pan-y/);

    // Le bloc téléphone ré-affirme le confinement après le reset global `* { touch-action: pan-y }`.
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(mobileBlock).toMatch(/\.task-search-results-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
    expect(mobileBlock).toMatch(/\.task-search-results-scroll\s*\{[^}]*touch-action:\s*pan-y/);
  });

  it("(b4) n'introduit pas un second propriétaire de défilement vertical", () => {
    const css = readAppFile("components/TaskSearchResultsPopover.css");
    const verticalOwners = [...css.matchAll(/([.#][\w-]+)\s*\{[^}]*overflow-y:\s*(auto|scroll)/g)]
      .map((match) => match[1]);
    expect(new Set(verticalOwners)).toEqual(new Set([".task-search-results-scroll"]));
  });
});
