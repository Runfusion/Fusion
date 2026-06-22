// Keep a generous cap so pasted multi-paragraph text stays visible while
// still preventing the composer from overtaking the message pane on short viewports.
export const CHAT_INPUT_MAX_HEIGHT_PX = 640;
export const TABLET_INPUT_MAX_HEIGHT_PX = 200;

export function resolveChatInputOverflowY(
  scrollHeight: number,
  maxHeight: number = CHAT_INPUT_MAX_HEIGHT_PX,
): "auto" | "hidden" {
  return scrollHeight > maxHeight ? "auto" : "hidden";
}

export function clampChatInputHeight(scrollHeight: number, maxHeight: number = CHAT_INPUT_MAX_HEIGHT_PX): number {
  // Floor matches the CSS min-height, so a 0-scrollHeight measurement (e.g.
  // before layout) still yields a sensible inline height instead of collapsing
  // the composer to 0.
  return Math.max(40, Math.min(scrollHeight, maxHeight));
}
