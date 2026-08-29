/**
 * FNXC:VoiceInput 2026-07-24-03:00:
 * Dictation performs real-time partial-to-final transcription at the caret. The returned anchor
 * keeps successive previews replacing in place so surrounding controlled-composer text survives.
 */
export type DictationAnchor = { start: number; end: number };
export type Insertion = { nextValue: string; nextCaret: number; anchor: DictationAnchor };

export function computeInsertion({ value, selectionStart, selectionEnd, insertText }: { value: string; selectionStart: number; selectionEnd: number; insertText: string }): Insertion {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const nextValue = `${value.slice(0, start)}${insertText}${value.slice(end)}`;
  const nextCaret = start + insertText.length;
  return { nextValue, nextCaret, anchor: { start, end: nextCaret } };
}

/** Replaces the previous dictated range; callers may shift the anchor when outside edits occur. */
export function replaceRange({ value, anchor, nextText }: { value: string; anchor: DictationAnchor; nextText: string }): Insertion {
  return computeInsertion({ value, selectionStart: anchor.start, selectionEnd: anchor.end, insertText: nextText });
}
