const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "range",
  "color",
  "hidden",
]);

export interface ComputeIcbOffsetsInput {
  innerWidth: number;
  innerHeight: number;
  vvWidth: number;
  vvHeight: number;
  vvOffsetTop: number;
  vvOffsetLeft: number;
  vvScale: number;
  activeElementIsKeyboardFocusable: boolean;
  baselineViewportHeight: number | null;
}

export interface IcbOffsets {
  rightOffset: number;
  bottomOffset: number;
}

export function isKeyboardFocusableInputType(type: string | null | undefined): boolean {
  if (!type) return true;
  return !NON_TEXT_INPUT_TYPES.has(type.toLowerCase());
}

export function computeIcbOffsets(input: ComputeIcbOffsetsInput): IcbOffsets {
  const {
    innerWidth,
    innerHeight,
    vvWidth,
    vvHeight,
    vvOffsetTop,
    vvOffsetLeft,
    vvScale,
    activeElementIsKeyboardFocusable,
    baselineViewportHeight,
  } = input;

  const rightOffset = Math.max(0, innerWidth - vvOffsetLeft - vvWidth);
  const rawBottomOffset = Math.max(0, innerHeight - vvOffsetTop - vvHeight);

  /*
  FNXC:ViewportChrome 2026-08-23-18:14:
  While a keyboard-focusable element is focused at scale <= 1.01, fixed bottom bars must stay pinned to the page bottom and be covered by the keyboard. A stale or absent baseline must never lift them.
  */
  if (activeElementIsKeyboardFocusable && vvScale <= 1.01) {
    return { rightOffset, bottomOffset: 0 };
  }

  if (!activeElementIsKeyboardFocusable || vvScale > 1.01 || baselineViewportHeight == null) {
    return { rightOffset, bottomOffset: rawBottomOffset };
  }

  const keyboardShrink = Math.max(0, baselineViewportHeight - vvHeight);
  if (keyboardShrink <= 0) {
    return { rightOffset, bottomOffset: rawBottomOffset };
  }

  return {
    rightOffset,
    bottomOffset: Math.max(0, rawBottomOffset - keyboardShrink),
  };
}
