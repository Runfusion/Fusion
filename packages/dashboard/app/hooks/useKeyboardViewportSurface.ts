import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  subscribeKeyboardViewport,
  type KeyboardViewportFrame,
} from "../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512: ONE container adapts its own bottom edge; its descendants adapt nothing.

The reported defect is the result of several owners compensating at once. A drawer clamped itself,
the chat thread inside it clamped itself again against the same visible bound, and a constant iOS
margin was added on top — so the field ended up either under the keyboard or pushed far above it
depending on which adjustment won the race.

This adapter therefore does two things and refuses to do a third:

1. It MEASURES the container's own rectangle and returns how much of it falls below the visible
   bottom edge. That is a real measurement of this element, not a keyboard height applied blindly,
   so it is correct for a full-screen drawer, a small floating window, and an inline region alike.
2. It PUBLISHES ownership through React context. A descendant that calls this hook inside an
   already-adapted ancestor is told `ownedByAncestor` and must leave its geometry alone. This is the
   single-owner rule, enforced structurally rather than by convention.
3. It NEVER grows a container. `bottomOverflow` is clamped at zero, so a compact dock or a short
   window keeps its own size instead of being stretched to the viewport.

A portal escapes the DOM but not the React tree, so a portalled surface that is genuinely its own
CSS containing block must pass `standalone` to opt out of an inherited owner it does not live inside.
*/

interface KeyboardViewportOwnership {
  /** True when an ancestor already adapted the visible bottom edge for this subtree. */
  owned: boolean;
}

const KeyboardViewportOwnerContext = createContext<KeyboardViewportOwnership>({ owned: false });

export const KeyboardViewportOwnerProvider = KeyboardViewportOwnerContext.Provider;

/** True when an ancestor container already adapted this subtree's bottom edge. */
export function useKeyboardViewportOwnedByAncestor(): boolean {
  return useContext(KeyboardViewportOwnerContext).owned;
}

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
Two anchoring shapes need two different stable answers, and getting this wrong is a feedback loop
rather than an off-by-some-pixels error.

- `measured` (default): the container's top edge does not move when its height changes — a floating
  window positioned by `top`, or a region in normal flow. `visibleBottom - naturalTop` is then stable
  across re-measures, and capping the height is the correct adaptation.
- `layout-bottom`: the container is anchored to the BOTTOM of the layout viewport, like the mobile
  drawer overlay. Shrinking it moves its top down, so any height derived from the current top feeds
  back into itself. Measured in a real browser this drove the drawer panel from 832px to 144px to 1px
  over successive observations. Such a container is adapted by its bottom INSET, taken straight from
  the frame with no element measurement at all, which has no feedback path.
*/
export type KeyboardViewportAnchor = "measured" | "layout-bottom";

export interface KeyboardViewportSurface {
  /**
   * Pixels of the container that currently fall below the visible bottom edge.
   * Zero whenever nothing is occluded, including when the browser already resized the layout.
   */
  bottomOverflow: number;
  /** For `layout-bottom` surfaces: how far the container's bottom edge must be pulled up. */
  bottomInset: number;
  /** Maximum block size the container may occupy so its bottom edge meets the visible bound. */
  maxBlockSize: number | null;
  /** The frame this surface was computed from. */
  frame: KeyboardViewportFrame | null;
  /** True when an ancestor owns the adaptation and this surface must not apply its own. */
  ownedByAncestor: boolean;
  /** Style object to spread onto the container, empty while nothing needs adapting. */
  style: Record<string, string>;
  /** Re-measure immediately; used after a layout change the viewport did not cause. */
  remeasure: () => void;
}

const INERT_SURFACE: KeyboardViewportSurface = {
  bottomOverflow: 0,
  bottomInset: 0,
  maxBlockSize: null,
  frame: null,
  ownedByAncestor: false,
  style: {},
  remeasure: () => {},
};

export interface UseKeyboardViewportSurfaceOptions {
  /** Whether this surface should adapt at all (visible, active, mobile-shaped host). */
  enabled?: boolean;
  /**
   * Ignore an inherited owner because this surface is its own containing block
   * (a portal rendered outside the ancestor's box).
   */
  standalone?: boolean;
  /**
   * CSS custom property that receives the usable block size. Defaults to
   * `--keyboard-visible-block-size`.
   */
  blockSizeProperty?: string;
  /** How this container is anchored; see {@link KeyboardViewportAnchor}. */
  anchor?: KeyboardViewportAnchor;
  /**
   * CSS custom property that receives the bottom inset for a `layout-bottom` surface.
   * Defaults to `--keyboard-bottom-inset`.
   */
  bottomInsetProperty?: string;
}

/**
 * Adapt one container to the visible viewport rectangle.
 *
 * The container keeps its normal resting geometry until part of it is genuinely below the visible
 * bottom edge, so nothing changes when no keyboard is up and closing the keyboard restores the
 * exact resting size.
 */
export function useKeyboardViewportSurface(
  ref: RefObject<HTMLElement | null>,
  {
    enabled = true,
    standalone = false,
    blockSizeProperty = "--keyboard-visible-block-size",
    anchor = "measured",
    bottomInsetProperty = "--keyboard-bottom-inset",
  }: UseKeyboardViewportSurfaceOptions = {},
): KeyboardViewportSurface {
  const inheritedOwner = useKeyboardViewportOwnedByAncestor();
  const ownedByAncestor = inheritedOwner && !standalone;
  const [frame, setFrame] = useState<KeyboardViewportFrame | null>(null);
  const [bottomOverflow, setBottomOverflow] = useState(0);
  const [maxBlockSize, setMaxBlockSize] = useState<number | null>(null);
  const frameRef = useRef<KeyboardViewportFrame | null>(null);
  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  The container's height while UNCLAMPED. This is the only stateful piece, and it exists to break a
  feedback loop: measuring `rect.height - overflow` and then applying that height makes the next
  measurement see the already-shortened box, so the value collapses toward zero over successive
  re-measures (a resize observation, a content change, a second viewport event). Measured in a real
  browser, that drove the panel to 1px.

  `visibleBottom - rect.top` has no such dependency: clamping the height does not move the top edge,
  so the answer is identical on every pass. The retained natural height is used only to decide WHETHER
  a clamp is needed and to report the overflow honestly while one is applied.
  */
  const naturalHeightRef = useRef<number | null>(null);
  /** The container's top edge and height while UNCLAMPED, for the `measured` anchor. */
  const naturalGeometryRef = useRef<{ top: number; height: number } | null>(null);
  /** Mirror of the published bound, so `measure` can tell a clamped pass from an unclamped one. */
  const maxBlockSizeRef = useRef<number | null>(null);

  const measure = useCallback((next: KeyboardViewportFrame | null) => {
    const element = ref.current;
    if (!element || !next) {
      setBottomOverflow(0);
      setMaxBlockSize(null);
      return;
    }

    if (anchor === "layout-bottom") {
      // No element measurement at all, and therefore no feedback path.
      setBottomOverflow(next.residualBottomInset);
      setMaxBlockSize(null);
      maxBlockSizeRef.current = null;
      naturalHeightRef.current = null;
      return;
    }

    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.height) || rect.height <= 0 || !Number.isFinite(rect.top)) {
      // jsdom and a hidden-but-mounted host both report an empty rect. Adapting from it would
      // publish a nonsense size, so the surface stays at its resting geometry instead.
      setBottomOverflow(0);
      setMaxBlockSize(null);
      return;
    }

    const clamped = maxBlockSizeRef.current !== null;
    if (!clamped || naturalGeometryRef.current === null) {
      naturalGeometryRef.current = { top: rect.top, height: rect.height };
    }
    const natural = naturalGeometryRef.current;

    // Stable: derived from the UNCLAMPED top edge, never from a height this hook may have set.
    const available = next.visibleBottom - natural.top;

    if (!Number.isFinite(available) || available <= 0 || available >= natural.height - 1) {
      setBottomOverflow(0);
      setMaxBlockSize(null);
      maxBlockSizeRef.current = null;
      naturalGeometryRef.current = null;
      return;
    }

    const nextMax = Math.max(0, available);
    maxBlockSizeRef.current = nextMax;
    setBottomOverflow(Math.max(0, natural.height - available));
    setMaxBlockSize(nextMax);
  }, [anchor, ref]);

  useLayoutEffect(() => {
    if (!enabled || ownedByAncestor) {
      frameRef.current = null;
      naturalHeightRef.current = null;
      naturalGeometryRef.current = null;
      maxBlockSizeRef.current = null;
      setFrame(null);
      setBottomOverflow(0);
      setMaxBlockSize(null);
      return;
    }

    const unsubscribe = subscribeKeyboardViewport((next) => {
      frameRef.current = next;
      setFrame(next);
      measure(next);
    });

    return () => {
      unsubscribe();
      frameRef.current = null;
      naturalHeightRef.current = null;
      naturalGeometryRef.current = null;
      maxBlockSizeRef.current = null;
      setFrame(null);
      setBottomOverflow(0);
      setMaxBlockSize(null);
    };
  }, [enabled, measure, ownedByAncestor]);

  const remeasure = useCallback(() => {
    if (!enabled || ownedByAncestor) return;
    measure(frameRef.current);
  }, [enabled, measure, ownedByAncestor]);

  // A container can change size for reasons unrelated to the viewport (content growth, a drawer
  // finishing its entry animation). Re-measure then, or the published bound describes a stale box.
  useEffect(() => {
    if (!enabled || ownedByAncestor) return;
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => remeasure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, ownedByAncestor, ref, remeasure]);

  if (!enabled) return INERT_SURFACE;

  const style: Record<string, string> = {};
  const effectiveOverflow = ownedByAncestor ? 0 : bottomOverflow;
  if (!ownedByAncestor && maxBlockSize !== null) {
    style[blockSizeProperty] = `${maxBlockSize}px`;
  }
  if (!ownedByAncestor && anchor === "layout-bottom" && effectiveOverflow > 0) {
    style[bottomInsetProperty] = `${effectiveOverflow}px`;
  }

  return {
    bottomOverflow: effectiveOverflow,
    bottomInset: anchor === "layout-bottom" ? effectiveOverflow : 0,
    maxBlockSize: ownedByAncestor ? null : maxBlockSize,
    frame,
    ownedByAncestor,
    style,
    remeasure,
  };
}
