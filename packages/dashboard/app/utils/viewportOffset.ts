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
