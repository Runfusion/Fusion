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

/*
FNXC:BoardNavigation 2026-07-26-10:05:
Mobile browsers (iOS Safari tab + installed PWA, Chrome Android) DISCARD a backgrounded dashboard tab and reload it from scratch when the user returns. The restore must land the user back where they were, so the snapshot is also replayed against a freshly hydrated board — not just against a board→detail→back remount.
A freshly reloaded board is EMPTY for as long as its first fetch takes, and scrolling an empty board silently scrolls to nothing and burns the restore. Treat a board with no rendered columns as "not ready yet" (return false so the caller retries) rather than as a successful restore.
Also refuse to replay a snapshot whose columns no longer exist at all (project switched, columns renamed/removed): a snapshot that matches nothing is a stale position, not a restorable one.
Scroll offsets themselves are NOT clamped here — assigning past the maximum is clamped natively by the engine, and computing a max from scrollWidth/clientWidth is meaningless in the layout-less test DOM.
*/
export function restoreBoardScrollSnapshot(snapshot: BoardScrollSnapshot | null, doc?: Document): boolean {
  if (!snapshot) return false;
  const ownerDocument = getBoardDocument(doc);
  if (!ownerDocument) return false;
  const board = ownerDocument.getElementById("board") as HTMLElement | null;
  if (!board) return false;

  const columns = Array.from(board.querySelectorAll<HTMLElement>(".column[data-column]"));
  if (columns.length === 0) return false;

  const snapshotColumnIds = Object.keys(snapshot.columnTops ?? {});
  if (
    snapshotColumnIds.length > 0
    && !snapshotColumnIds.some((columnId) => columns.some((column) => column.dataset.column === columnId))
  ) {
    return false;
  }

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
  columns.forEach((column) => {
    const columnId = column.dataset.column;
    const body = column.querySelector<HTMLElement>(".column-body");
    if (columnId && body && Object.prototype.hasOwnProperty.call(snapshot.columnTops, columnId)) {
      body.scrollTop = snapshot.columnTops[columnId];
    }
  });

  return true;
}

/*
FNXC:BoardNavigation 2026-07-26-10:12:
The board scroll snapshot lived only in a useRef, so an OS/browser tab discard (the mobile white-splash reload) wiped it and dropped the user at the top of the board.
sessionStorage is the correct store for it: it survives a reload AND a discard-restore of the same tab, but is NOT inherited by a brand-new tab — a new tab is a fresh boot and must start at the top of the board. localStorage would leak yesterday's scroll position into every new tab.
The payload is scroll offsets only (numbers keyed by column id); it never carries task content.
*/
const BOARD_SCROLL_SESSION_KEY = "kb-dashboard-board-scroll";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.sessionStorage;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;
    return storage;
  } catch {
    // Safari private mode / disabled storage: scroll restore is a nicety, never a hard failure.
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBoardScrollSnapshot(raw: string): BoardScrollSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  const numericKeys = [
    "boardLeft",
    "boardTop",
    "projectContentLeft",
    "projectContentTop",
    "documentLeft",
    "documentTop",
  ] as const;
  if (!numericKeys.every((key) => isFiniteNumber(candidate[key]))) return null;

  const rawColumnTops = candidate.columnTops;
  if (!rawColumnTops || typeof rawColumnTops !== "object") return null;
  const columnTops: Record<string, number> = {};
  for (const [columnId, top] of Object.entries(rawColumnTops as Record<string, unknown>)) {
    if (!isFiniteNumber(top)) return null;
    columnTops[columnId] = top;
  }

  return {
    boardLeft: candidate.boardLeft as number,
    boardTop: candidate.boardTop as number,
    columnTops,
    projectContentLeft: candidate.projectContentLeft as number,
    projectContentTop: candidate.projectContentTop as number,
    documentLeft: candidate.documentLeft as number,
    documentTop: candidate.documentTop as number,
  };
}

export function persistBoardScrollSnapshot(snapshot: BoardScrollSnapshot | null): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    if (!snapshot) {
      storage.removeItem(BOARD_SCROLL_SESSION_KEY);
      return;
    }
    storage.setItem(BOARD_SCROLL_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota/serialization failures must never break navigation.
  }
}

export function readPersistedBoardScrollSnapshot(): BoardScrollSnapshot | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(BOARD_SCROLL_SESSION_KEY);
    return raw ? parseBoardScrollSnapshot(raw) : null;
  } catch {
    return null;
  }
}

export function clearPersistedBoardScrollSnapshot(): void {
  persistBoardScrollSnapshot(null);
}
