import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_SCROLL_RESTORE_EVENT,
  captureBoardScrollSnapshot,
  readPersistedBoardScrollSnapshot,
  restoreBoardScrollSnapshot,
} from "../boardScrollSnapshot";

describe("boardScrollSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as Document & { scrollingElement?: Element | null }).scrollingElement;
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it("restores horizontal context while every column starts at the top", () => {
    document.body.innerHTML = `
      <div class="project-content">
        <main id="board">
          <section class="column" data-column="todo"><div class="column-body"></div></section>
          <section class="column" data-column="in-progress"><div class="column-body"></div></section>
        </main>
      </div>
    `;
    const projectContent = document.querySelector(".project-content") as HTMLElement;
    const board = document.getElementById("board") as HTMLElement;
    const todoBody = document.querySelector('[data-column="todo"] .column-body') as HTMLElement;
    const activeBody = document.querySelector('[data-column="in-progress"] .column-body') as HTMLElement;

    projectContent.scrollLeft = 4;
    projectContent.scrollTop = 22;
    board.scrollLeft = 240;
    board.scrollTop = 12;
    todoBody.scrollTop = 380;
    activeBody.scrollTop = 95;

    const snapshot = captureBoardScrollSnapshot();

    projectContent.scrollLeft = 0;
    projectContent.scrollTop = 0;
    board.scrollLeft = 0;
    board.scrollTop = 0;
    todoBody.scrollTop = 0;
    activeBody.scrollTop = 0;

    expect(restoreBoardScrollSnapshot(snapshot)).toBe(true);
    expect(projectContent.scrollLeft).toBe(4);
    expect(projectContent.scrollTop).toBe(22);
    expect(board.scrollLeft).toBe(240);
    expect(board.scrollTop).toBe(12);
    expect(snapshot?.columnTops).toEqual({ todo: 0, "in-progress": 0 });
    expect(todoBody.scrollTop).toBe(0);
    expect(activeBody.scrollTop).toBe(0);
  });

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  FN-500 : la restauration s'annonce avant TOUTE écriture pour que le magnétisme mobile cède l'axe, y
  compris quand le déplacement est plus petit que la tolérance de dérive compositeur. Une restauration
  refusée (colonnes absentes ou snapshot sans correspondance) ne doit rien annoncer du tout.
  */
  it("announces a restore before it writes, whatever its amplitude", () => {
    document.body.innerHTML = `
      <main id="board">
        <section class="column" data-column="todo"><div class="column-body"></div></section>
      </main>
    `;
    const board = document.getElementById("board") as HTMLElement;
    board.scrollLeft = 300;
    const observed: number[] = [];
    board.addEventListener(BOARD_SCROLL_RESTORE_EVENT, () => observed.push(board.scrollLeft));

    // A tiny restore (below the compositor drift tolerance) still announces itself.
    expect(restoreBoardScrollSnapshot({
      boardLeft: 312,
      boardTop: 0,
      columnTops: { todo: 0 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(true);
    expect(observed).toEqual([300]);
    expect(board.scrollLeft).toBe(312);

    // A large restore announces itself exactly once too.
    expect(restoreBoardScrollSnapshot({
      boardLeft: 900,
      boardTop: 0,
      columnTops: { todo: 0 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(true);
    expect(observed).toEqual([300, 312]);
  });

  it("announces nothing when the restore is refused", () => {
    document.body.innerHTML = `<main id="board"></main>`;
    const board = document.getElementById("board") as HTMLElement;
    board.scrollLeft = 120;
    const announced = vi.fn();
    board.addEventListener(BOARD_SCROLL_RESTORE_EVENT, announced);

    expect(restoreBoardScrollSnapshot({
      boardLeft: 40,
      boardTop: 0,
      columnTops: { todo: 0 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(false);

    expect(announced).not.toHaveBeenCalled();
    expect(board.scrollLeft).toBe(120);
  });

  it("zeros every rendered column from a legacy snapshot with non-zero offsets", () => {
    document.body.innerHTML = `
      <main id="board">
        <section class="column" data-column="todo"><div class="column-body"></div></section>
        <section class="column" data-column="done"><div class="column-body"></div></section>
      </main>
    `;
    const bodies = Array.from(document.querySelectorAll<HTMLElement>(".column-body"));
    bodies[0]!.scrollTop = 12;
    bodies[1]!.scrollTop = 900;

    expect(restoreBoardScrollSnapshot({
      boardLeft: 77,
      boardTop: 0,
      columnTops: { todo: 380, done: 8_000 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(true);

    expect((document.getElementById("board") as HTMLElement).scrollLeft).toBe(77);
    expect(bodies.map((body) => body.scrollTop)).toEqual([0, 0]);
  });

  it("round-trips document scroll without requiring the project-content shell", () => {
    document.body.innerHTML = `
      <main id="board">
        <section class="column" data-column="todo"><div class="column-body"></div></section>
      </main>
    `;
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: document.documentElement,
    });
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((leftOrOptions?: number | ScrollToOptions, top?: number) => {
      if (typeof leftOrOptions === "number") {
        Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: leftOrOptions });
        Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: top ?? window.scrollY });
        return;
      }
      Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: leftOrOptions?.left ?? window.scrollX });
      Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: leftOrOptions?.top ?? window.scrollY });
    });
    const board = document.getElementById("board") as HTMLElement;

    board.scrollLeft = 40;
    board.scrollTop = 8;
    document.documentElement.scrollLeft = 13;
    document.documentElement.scrollTop = 144;

    const snapshot = captureBoardScrollSnapshot();

    expect(snapshot).toMatchObject({
      boardLeft: 40,
      boardTop: 8,
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 13,
      documentTop: 144,
    });

    board.scrollLeft = 0;
    board.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
    document.documentElement.scrollTop = 0;
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });

    expect(restoreBoardScrollSnapshot(snapshot)).toBe(true);
    expect(document.documentElement.scrollLeft).toBe(13);
    expect(document.documentElement.scrollTop).toBe(144);
    expect(board.scrollLeft).toBe(40);
    expect(board.scrollTop).toBe(8);
    expect(scrollTo).toHaveBeenCalledWith(13, 144);
  });

  it.each([
    "not-json",
    JSON.stringify({ boardLeft: 2, columnTops: {} }),
    JSON.stringify({ boardLeft: 2, boardTop: 0, columnTops: { done: "far" }, projectContentLeft: 0, projectContentTop: 0, documentLeft: 0, documentTop: 0 }),
  ])("ignores an absent or invalid persisted snapshot: %s", (raw) => {
    window.sessionStorage.setItem("kb-dashboard-board-scroll", raw);
    expect(readPersistedBoardScrollSnapshot()).toBeNull();
  });

  it("returns false when the board is not mounted", () => {
    document.body.innerHTML = "";

    expect(captureBoardScrollSnapshot()).toBeNull();
    expect(restoreBoardScrollSnapshot({
      boardLeft: 10,
      boardTop: 0,
      columnTops: {},
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    })).toBe(false);
  });
});
