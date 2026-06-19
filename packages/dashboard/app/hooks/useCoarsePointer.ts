import { useEffect, useState } from "react";

// Touch-primary devices (phones/tablets, Android WebViews). A hybrid laptop
// with a trackpad/mouse reports `(hover: hover)` and is intentionally excluded
// so mouse drag-to-move keeps working there.
export const COARSE_POINTER_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches;
}

// Whether the primary pointer is coarse (touch). Native HTML5 drag-and-drop is
// non-functional via touch, yet a `draggable` element still arms the browser's
// touch-drag heuristic and can hijack a horizontal swipe meant to scroll the
// board. Components use this to drop `draggable` on touch so panning is reliable.
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(isCoarsePointer);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(COARSE_POINTER_MEDIA_QUERY);
    const update = () => setCoarse(query.matches);

    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return coarse;
}
