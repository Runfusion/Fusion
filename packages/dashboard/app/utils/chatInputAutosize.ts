/*
FNXC:ChatComposer 2026-08-20-19:25:
FN-076 requires every dashboard chat textarea to grow automatically through five rendered lines, scroll excess content internally, and return to its minimum height after content is removed or cleared. Manual mouse resizing is intentionally unavailable so one controller-owned measurement remains the only height authority.
*/

export const CHAT_INPUT_MAX_LINES = 5;
export const CHAT_INPUT_MIN_HEIGHT_PX = 40;
const FALLBACK_LINE_HEIGHT_PX = 20;
const FALLBACK_VERTICAL_PADDING_PX = 16;
const FALLBACK_VERTICAL_BORDER_PX = 2;

export interface ChatInputBoxMetrics {
  lineHeightPx: number;
  paddingTopPx: number;
  paddingBottomPx: number;
  borderTopPx: number;
  borderBottomPx: number;
}

export interface ChatInputAutosizeController {
  resize(): void;
  destroy(): void;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseCssPixels(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readComputedStyle(textarea: HTMLTextAreaElement): CSSStyleDeclaration | null {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
  return window.getComputedStyle(textarea);
}

export function getChatInputBoxMetrics(textarea: HTMLTextAreaElement): ChatInputBoxMetrics {
  const style = readComputedStyle(textarea);
  const fontSize = finitePositive(parseCssPixels(style?.fontSize ?? "") ?? Number.NaN, 16);
  const lineHeightValue = style?.lineHeight ?? "";
  const parsedLineHeight = parseCssPixels(lineHeightValue);
  const lineHeightPx = finitePositive(
    parsedLineHeight === null
      ? Number.NaN
      : lineHeightValue.trim().endsWith("px")
        ? parsedLineHeight
        : parsedLineHeight * fontSize,
    FALLBACK_LINE_HEIGHT_PX,
  );

  return {
    lineHeightPx,
    paddingTopPx: parseCssPixels(style?.paddingTop) ?? FALLBACK_VERTICAL_PADDING_PX / 2,
    paddingBottomPx: parseCssPixels(style?.paddingBottom) ?? FALLBACK_VERTICAL_PADDING_PX / 2,
    borderTopPx: parseCssPixels(style?.borderTopWidth) ?? FALLBACK_VERTICAL_BORDER_PX / 2,
    borderBottomPx: parseCssPixels(style?.borderBottomWidth) ?? FALLBACK_VERTICAL_BORDER_PX / 2,
  };
}

export function getChatInputAutomaticMaxHeight(metrics: ChatInputBoxMetrics): number {
  const lineHeight = finitePositive(metrics.lineHeightPx, FALLBACK_LINE_HEIGHT_PX);
  const chrome = Math.max(0, metrics.paddingTopPx)
    + Math.max(0, metrics.paddingBottomPx)
    + Math.max(0, metrics.borderTopPx)
    + Math.max(0, metrics.borderBottomPx);
  return Math.max(CHAT_INPUT_MIN_HEIGHT_PX, Math.ceil(lineHeight * CHAT_INPUT_MAX_LINES + chrome));
}

// The default is a deterministic zero-layout fallback for callers that only have a scrollHeight.
// Mounted composers use getChatInputAutomaticMaxHeight so their actual line box and box chrome win.
export const CHAT_INPUT_DEFAULT_MAX_HEIGHT_PX = getChatInputAutomaticMaxHeight({
  lineHeightPx: FALLBACK_LINE_HEIGHT_PX,
  paddingTopPx: FALLBACK_VERTICAL_PADDING_PX / 2,
  paddingBottomPx: FALLBACK_VERTICAL_PADDING_PX / 2,
  borderTopPx: FALLBACK_VERTICAL_BORDER_PX / 2,
  borderBottomPx: FALLBACK_VERTICAL_BORDER_PX / 2,
});

export function resolveChatInputOverflowY(
  scrollHeight: number,
  maxHeight: number = CHAT_INPUT_DEFAULT_MAX_HEIGHT_PX,
): "auto" | "hidden" {
  return Number.isFinite(scrollHeight) && scrollHeight > maxHeight ? "auto" : "hidden";
}

export function clampChatInputHeight(
  scrollHeight: number,
  maxHeight: number = CHAT_INPUT_DEFAULT_MAX_HEIGHT_PX,
): number {
  const safeMaxHeight = Math.max(CHAT_INPUT_MIN_HEIGHT_PX, finitePositive(maxHeight, CHAT_INPUT_DEFAULT_MAX_HEIGHT_PX));
  const safeScrollHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  return Math.max(CHAT_INPUT_MIN_HEIGHT_PX, Math.min(safeScrollHeight, safeMaxHeight));
}

/** Attach automatic-only five-line sizing to one mounted dashboard chat textarea. */
export function createChatInputAutosizeController(textarea: HTMLTextAreaElement): ChatInputAutosizeController {
  let destroyed = false;

  const resize = () => {
    if (destroyed) return;

    // Clear the previous used size before measurement so shortened and empty controlled drafts shrink.
    textarea.style.height = "0px";
    const maxHeight = getChatInputAutomaticMaxHeight(getChatInputBoxMetrics(textarea));
    const contentHeight = Number.isFinite(textarea.scrollHeight) ? textarea.scrollHeight : 0;
    const nextHeight = clampChatInputHeight(contentHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = resolveChatInputOverflowY(contentHeight, maxHeight);
  };

  resize();

  return {
    resize,
    destroy() {
      destroyed = true;
    },
  };
}
