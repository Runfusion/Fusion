import { useEffect, type RefObject } from "react";

import { isMobileViewport } from "./useViewportMode";

interface PersistedSize {
  width?: number;
  height?: number;
}

const RESIZE_GRIP_CLASS = "modal-resize-grip";
const RESIZE_GRIP_LABEL = "Resize modal from bottom-right corner";

interface ModalResizePersistOptions {
  /** Enable the explicit 44px hit target on the tablet-touch task-detail surface. */
  touchTargets?: boolean;
}

/*
FNXC:TaskModalResize 2026-07-24-19:20:
The shared Task Detail grip must offer the same keyboard discovery as floating task windows.
Use the established modal viewport-padding quantum so arrow keys adjust its two dimensions
without creating a second resize scale or bypassing the existing persistence path.
*/
const KEYBOARD_RESIZE_STEP = 16;

function readPersistableSize(node: HTMLElement): PersistedSize {
  const styleWidth = Number.parseFloat(node.style.width);
  const styleHeight = Number.parseFloat(node.style.height);
  return {
    width: node.offsetWidth > 0
      ? node.offsetWidth
      : Number.isFinite(styleWidth)
        ? styleWidth
        : undefined,
    height: node.offsetHeight > 0
      ? node.offsetHeight
      : Number.isFinite(styleHeight)
        ? styleHeight
        : undefined,
  };
}

/**
 * Persist a resizable modal's user-chosen dimensions across opens.
 *
 * Pair this with `resize: both` in CSS on the modal element. When the user
 * drags the resize grip, the new pixel size is captured via ResizeObserver
 * and stored under `storageKey`. On the next open, the stored size is
 * replayed as inline `width` / `height` styles before the modal becomes
 * interactive.
 *
 * The CSS `min-*` / `max-*` constraints still clamp the applied size at
 * render time, so a value saved on a 4K display won't break the layout
 * when reopened on a laptop.
 *
 * @param ref     ref to the resizable modal element
 * @param isOpen  the modal's open flag — observation only runs while true
 * @param storageKey  localStorage key, must be stable + unique per modal
 * @param options tablet-only touch-target opt-in; other shared modal consumers retain desktop geometry
 */
/*
FNXC:ModalTouchGeometry 2026-07-26-19:30:
FN-8619 migrated every product modal consumer to FloatingWindow. Keep this hook, its grip CSS,
and tests because the Chromium touch-geometry e2e fixture still exercises the legacy resize seam.
*/
export function useModalResizePersist(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  storageKey: string,
  options: ModalResizePersistOptions = {},
): void {
  useEffect(() => {
    if (!isOpen) return;
    const node = ref.current;
    if (!node) return;

    // On mobile, modals render full-screen via CSS (height: 100dvh) and the
    // resize grip is disabled. Replaying a desktop-saved pixel height here
    // would override the mobile CSS and leave the modal stuck at a partial
    // height. Skip restoration; also clear any width/height left over from
    // a prior desktop render of the same modal instance.
    const existingGrip = node.querySelector(`:scope > .${RESIZE_GRIP_CLASS}`);

    if (isMobileViewport()) {
      node.style.removeProperty("width");
      node.style.removeProperty("height");
      existingGrip?.remove();
      return;
    }

    // Apply the persisted size on open.
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const { width, height } = JSON.parse(raw) as PersistedSize;
        if (typeof width === "number" && width > 0) node.style.width = `${width}px`;
        if (typeof height === "number" && height > 0) node.style.height = `${height}px`;
      }
    } catch {
      // ignore corrupted entry
    }

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSave = () => {
      const { width, height } = readPersistableSize(node);
      if (typeof width !== "number" || typeof height !== "number") return;
      // Debounce so we don't spam localStorage during the drag.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(storageKey, JSON.stringify({ width, height }));
        } catch {
          // quota / private mode — best-effort
        }
      }, 200);
    };

    const grip = document.createElement("div");
    grip.className = `${RESIZE_GRIP_CLASS}${options.touchTargets ? " modal-resize-grip--touch-target" : ""}`;
    if (options.touchTargets) {
      /*
      FNXC:TaskModalResize 2026-07-26-10:40:
      Keep the painted corner grip mouse-sized while exposing a separately queryable
      touch hit target. This lets tablet touch input land outside the legacy visual
      corner without enlarging borders, footer chrome, or content hit areas.
      */
      grip.dataset.resizeHitTarget = "true";
    }
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-label", RESIZE_GRIP_LABEL);
    grip.setAttribute("aria-orientation", "vertical");
    grip.setAttribute("aria-valuemin", "0");
    grip.setAttribute("aria-valuemax", String(window.innerWidth));
    grip.tabIndex = 0;
    grip.dataset.resizeDirection = "se";
    existingGrip?.remove();
    node.appendChild(grip);

    const syncGripAria = () => {
      const { width, height } = readPersistableSize(node);
      if (typeof width !== "number" || typeof height !== "number") return;
      grip.setAttribute("aria-valuenow", String(Math.round(width)));
      grip.setAttribute("aria-valuetext", `Width ${Math.round(width)} pixels, height ${Math.round(height)} pixels`);
    };
    syncGripAria();

    let lastSavedW = node.offsetWidth;
    let lastSavedH = node.offsetHeight;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const w = node.offsetWidth;
            const h = node.offsetHeight;
            syncGripAria();
            if (w === lastSavedW && h === lastSavedH) return;
            lastSavedW = w;
            lastSavedH = h;
            scheduleSave();
          });

    observer?.observe(node);

    let cleanupActiveDrag: (() => void) | null = null;

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (typeof grip.setPointerCapture === "function") {
        grip.setPointerCapture(event.pointerId);
      }

      const startRect = node.getBoundingClientRect();
      const startWidth = startRect.width ||
        node.offsetWidth ||
        Number.parseFloat(node.style.width) ||
        0;
      const startHeight = startRect.height ||
        node.offsetHeight ||
        Number.parseFloat(node.style.height) ||
        0;
      const startX = event.clientX;
      const startY = event.clientY;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        moveEvent.preventDefault();
        const nextWidth = Math.min(window.innerWidth, startWidth + moveEvent.clientX - startX);
        const nextHeight = Math.min(window.innerHeight, startHeight + moveEvent.clientY - startY);
        if (nextWidth > 0) node.style.width = `${nextWidth}px`;
        if (nextHeight > 0) node.style.height = `${nextHeight}px`;
        syncGripAria();
        scheduleSave();
      };

      const endDrag = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        if (typeof grip.releasePointerCapture === "function") {
          grip.releasePointerCapture(upEvent.pointerId);
        }
        document.body.style.userSelect = previousUserSelect;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", endDrag);
        document.removeEventListener("pointercancel", endDrag);
        scheduleSave();
        cleanupActiveDrag = null;
      };

      cleanupActiveDrag = () => {
        document.body.style.userSelect = previousUserSelect;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", endDrag);
        document.removeEventListener("pointercancel", endDrag);
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", endDrag);
      document.addEventListener("pointercancel", endDrag);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      let widthDelta = 0;
      let heightDelta = 0;
      if (event.key === "ArrowRight") widthDelta = KEYBOARD_RESIZE_STEP;
      if (event.key === "ArrowLeft") widthDelta = -KEYBOARD_RESIZE_STEP;
      if (event.key === "ArrowDown") heightDelta = KEYBOARD_RESIZE_STEP;
      if (event.key === "ArrowUp") heightDelta = -KEYBOARD_RESIZE_STEP;
      if (widthDelta === 0 && heightDelta === 0) return;

      event.preventDefault();
      event.stopPropagation();
      const { width = 0, height = 0 } = readPersistableSize(node);
      if (width + widthDelta > 0) node.style.width = `${width + widthDelta}px`;
      if (height + heightDelta > 0) node.style.height = `${height + heightDelta}px`;
      syncGripAria();
      scheduleSave();
    };

    grip.addEventListener("pointerdown", onPointerDown);
    grip.addEventListener("keydown", onKeyDown);

    return () => {
      cleanupActiveDrag?.();
      grip.removeEventListener("pointerdown", onPointerDown);
      grip.removeEventListener("keydown", onKeyDown);
      grip.remove();
      observer?.disconnect();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [ref, isOpen, storageKey, options.touchTargets]);
}
