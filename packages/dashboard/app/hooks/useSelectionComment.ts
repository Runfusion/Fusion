import { useCallback, useEffect, useState, type RefObject } from "react";

export interface SelectionCommentLineRange {
  start: number;
  end: number;
}

export interface SelectionCommentState {
  selectedText: string;
  anchorRect: DOMRect;
  lineRange?: SelectionCommentLineRange;
}

interface UseSelectionCommentOptions {
  getLineRange?: (selection: Selection) => SelectionCommentLineRange | undefined;
  locked?: boolean;
}

function isNodeInside(container: HTMLElement, node: Node | null): boolean {
  if (!node) return false;
  return container === node || container.contains(node);
}

function getRangeAnchorRect(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }
  const firstRect = range.getClientRects()[0];
  return firstRect ?? null;
}

/**
 * FNXC:SelectionComment 2026-06-16-23:49:
 * File content surfaces need a shared selection detector so editor, markdown preview, and read-only preview containers can offer the same comment-to-New-Task affordance without mutating the file or disrupting copy selection.
 */
export function useSelectionComment(
  containerRef: RefObject<HTMLElement | null>,
  options: UseSelectionCommentOptions = {},
): SelectionCommentState | null {
  const { getLineRange, locked = false } = options;
  const [selectionState, setSelectionState] = useState<SelectionCommentState | null>(null);

  const refreshSelection = useCallback(() => {
    if (locked) {
      return;
    }

    const container = containerRef.current;
    const selection = document.getSelection();
    if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionState(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) {
      setSelectionState(null);
      return;
    }

    if (!isNodeInside(container, range.commonAncestorContainer) || !isNodeInside(container, selection.anchorNode) || !isNodeInside(container, selection.focusNode)) {
      setSelectionState(null);
      return;
    }

    const anchorRect = getRangeAnchorRect(range);
    if (!anchorRect) {
      setSelectionState(null);
      return;
    }

    setSelectionState({
      selectedText,
      anchorRect,
      lineRange: getLineRange?.(selection),
    });
  }, [containerRef, getLineRange, locked]);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshSelection);
    document.addEventListener("mouseup", refreshSelection);
    document.addEventListener("touchend", refreshSelection);
    document.addEventListener("keyup", refreshSelection);
    return () => {
      document.removeEventListener("selectionchange", refreshSelection);
      document.removeEventListener("mouseup", refreshSelection);
      document.removeEventListener("touchend", refreshSelection);
      document.removeEventListener("keyup", refreshSelection);
    };
  }, [refreshSelection]);

  return selectionState;
}
