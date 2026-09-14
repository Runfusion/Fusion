import { useCallback } from "react";
import {
  useHorizontalMousePan,
  type HorizontalMousePanBindings,
} from "./useHorizontalMousePan";

export type BoardMousePanBindings = HorizontalMousePanBindings;

/*
FNXC:BoardNavigation 2026-09-12-17:32:
The Board adapts the shared delayed-capture mouse pan without widening its start surface. Stationary card bodies remain native, while controls, editing cards, links, editable content, and draggable sources never become pan candidates; touch and column snap behavior remain unchanged.
*/
function isAllowedBoardPanTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    ".card-editing, button, a, input, textarea, select, option, label, summary, [contenteditable='true'], [draggable='true'], [role='button'], [role='link'], [role='textbox'], [role='menuitem'], [role='checkbox'], [role='combobox'], [role='radio'], [role='slider'], [role='switch']",
  );
}

export function useBoardMousePan(boardElement: HTMLElement | null, enabled: boolean): BoardMousePanBindings {
  const canStartFrom = useCallback(isAllowedBoardPanTarget, []);
  return useHorizontalMousePan(boardElement, { enabled, canStartFrom });
}
