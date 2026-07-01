export interface BoardScrollSnapshot {
  boardLeft: number;
  boardTop: number;
  columnTops: Record<string, number>;
  projectContentLeft: number;
  projectContentTop: number;
  documentLeft: number;
  documentTop: number;
}

function getBoardDocument(doc?: Document): Document | null {
  if (doc) return doc;
  return typeof document === "undefined" ? null : document;
}

/*
FNXC:BoardNavigation 2026-06-22-20:15:
Board-card task detail replaces the board instead of overlaying it. Capture horizontal board scroll and per-column vertical scroll before opening detail, then restore after Back to board remounts the board so users return to the same lane/card context.

FNXC:BoardNavigation 2026-06-29-20:45:
Mobile Back-to-board must restore the clicked-card board position even when the browser parks scroll on the project-content/document shell during the full-panel task-detail transition. Snapshot the shell offsets alongside #board and .column-body; CSS keeps #board as the horizontal scroller and .column-body as the vertical lane scroller, but restoring the shell defensively prevents mobile viewport drift from hiding the clicked card after return.
*/
export function captureBoardScrollSnapshot(doc?: Document): BoardScrollSnapshot | null {
  const ownerDocument = getBoardDocument(doc);
  if (!ownerDocument) return null;
  const board = ownerDocument.getElementById("board") as HTMLElement | null;
  if (!board) return null;

  const projectContent = ownerDocument.querySelector<HTMLElement>(".project-content");
  const scrollingElement = ownerDocument.scrollingElement as HTMLElement | null;
  const defaultView = ownerDocument.defaultView;
  const columnTops: Record<string, number> = {};
  board.querySelectorAll<HTMLElement>(".column[data-column]").forEach((column) => {
    const columnId = column.dataset.column;
    const body = column.querySelector<HTMLElement>(".column-body");
    if (columnId && body) {
      columnTops[columnId] = body.scrollTop;
    }
  });

  return {
    boardLeft: board.scrollLeft,
    boardTop: board.scrollTop,
    columnTops,
    projectContentLeft: projectContent?.scrollLeft ?? 0,
    projectContentTop: projectContent?.scrollTop ?? 0,
    documentLeft: scrollingElement?.scrollLeft ?? defaultView?.scrollX ?? 0,
    documentTop: scrollingElement?.scrollTop ?? defaultView?.scrollY ?? 0,
  };
}

export function restoreBoardScrollSnapshot(snapshot: BoardScrollSnapshot | null, doc?: Document): boolean {
  if (!snapshot) return false;
  const ownerDocument = getBoardDocument(doc);
  if (!ownerDocument) return false;
  const board = ownerDocument.getElementById("board") as HTMLElement | null;
  if (!board) return false;

  const projectContent = ownerDocument.querySelector<HTMLElement>(".project-content");
  const scrollingElement = ownerDocument.scrollingElement as HTMLElement | null;
  const defaultView = ownerDocument.defaultView;
  if (projectContent) {
    projectContent.scrollLeft = snapshot.projectContentLeft ?? 0;
    projectContent.scrollTop = snapshot.projectContentTop ?? 0;
  }
  if (scrollingElement) {
    scrollingElement.scrollLeft = snapshot.documentLeft ?? 0;
    scrollingElement.scrollTop = snapshot.documentTop ?? 0;
  }
  const documentLeft = snapshot.documentLeft ?? 0;
  const documentTop = snapshot.documentTop ?? 0;
  if (defaultView && (defaultView.scrollX !== documentLeft || defaultView.scrollY !== documentTop)) {
    try {
      defaultView.scrollTo(documentLeft, documentTop);
    } catch {
      // Test DOMs may expose scrollTo without implementing it; element offsets above still cover the restore contract.
    }
  }

  board.scrollLeft = snapshot.boardLeft;
  board.scrollTop = snapshot.boardTop;
  board.querySelectorAll<HTMLElement>(".column[data-column]").forEach((column) => {
    const columnId = column.dataset.column;
    const body = column.querySelector<HTMLElement>(".column-body");
    if (columnId && body && Object.prototype.hasOwnProperty.call(snapshot.columnTops, columnId)) {
      body.scrollTop = snapshot.columnTops[columnId];
    }
  });

  return true;
}
