import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBoardScrollSnapshot, restoreBoardScrollSnapshot } from "../boardScrollSnapshot";

describe("boardScrollSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as Document & { scrollingElement?: Element | null }).scrollingElement;
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
    document.body.innerHTML = "";
  });

  it("round-trips board horizontal scroll and per-column vertical scroll", () => {
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
    expect(todoBody.scrollTop).toBe(380);
    expect(activeBody.scrollTop).toBe(95);
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
