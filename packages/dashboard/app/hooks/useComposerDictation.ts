import { useCallback, useLayoutEffect, useRef } from "react";
import { computeInsertion, replaceRange, type DictationAnchor } from "../components/insertAtCaret";
import { useVoiceDictation } from "./useVoiceDictation";

/**
 * FNXC:VoiceInput 2026-07-24-03:15:
 * Each controlled composer owns one adapter instance. Its private anchor replaces partial text
 * in place and restores selection after React renders, preventing one composer from clobbering another.
 */
export function useComposerDictation({ textareaRef, value, onChange, onResize, projectId }: { textareaRef: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (nextValue: string) => void; onResize?: () => void; projectId?: string }) {
  const voice = useVoiceDictation(projectId);
  const resizeRef = useRef(onResize); resizeRef.current = onResize;
  const pendingResizeRef = useRef(false);
  const valueRef = useRef(value); valueRef.current = value;
  const anchorRef = useRef<DictationAnchor | undefined>(undefined);
  const appliedRef = useRef<string | undefined>(undefined);
  const pendingCaretRef = useRef<number | undefined>(undefined);
  /*
   * FNXC:VoiceInput 2026-07-25-12:20:
   * A mounted composer must not consume another composer's dictation events. Only its own mic
   * start arms partial-to-final replacement, preserving independent ChatView composer anchors.
   */
  const sessionActiveRef = useRef(false);
  const lastPartialRef = useRef("");
  const reconcileExternalEdit = useCallback((current: string, node: HTMLTextAreaElement) => {
    const applied = appliedRef.current;
    const anchor = anchorRef.current;
    if (!applied || !anchor || applied === current) return;

    let prefix = 0;
    while (prefix < applied.length && prefix < current.length && applied[prefix] === current[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < applied.length - prefix && suffix < current.length - prefix && applied[applied.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;
    const previousEditEnd = applied.length - suffix;
    const nextEditEnd = current.length - suffix;

    if (previousEditEnd <= anchor.start) {
      const delta = nextEditEnd - previousEditEnd;
      anchorRef.current = { start: anchor.start + delta, end: anchor.end + delta };
    } else if (prefix < anchor.end) {
      // FNXC:VoiceInput 2026-07-24-04:10:
      // An edit touching the preview commits that preview and reanchors at the live selection;
      // later speech must not overwrite text typed by the operator during dictation.
      anchorRef.current = { start: node.selectionStart, end: node.selectionEnd };
    }
    appliedRef.current = current;
  }, []);
  const apply = useCallback((text: string, initial = false) => {
    const node = textareaRef.current; if (!node) return;
    const current = valueRef.current;
    reconcileExternalEdit(current, node);
    const result = initial || !anchorRef.current
      ? computeInsertion({ value: current, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd, insertText: text })
      : replaceRange({ value: current, anchor: anchorRef.current, nextText: text });
    anchorRef.current = result.anchor; appliedRef.current = result.nextValue; pendingCaretRef.current = result.nextCaret; pendingResizeRef.current = true; lastPartialRef.current = text;
    onChange(result.nextValue);
  }, [onChange, reconcileExternalEdit, textareaRef]);
  /*
   * FNXC:VoiceInput 2026-07-24-05:00:
   * Dictated controlled-value updates run the caller's existing resize routine after React commits.
   * This preserves autosize parity with keyboard input without mutating textarea.value directly.
   */
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret !== undefined && textareaRef.current) {
      textareaRef.current.setSelectionRange(caret, caret);
      pendingCaretRef.current = undefined;
    }
    if (pendingResizeRef.current) {
      pendingResizeRef.current = false;
      resizeRef.current?.();
    }
  }, [value, textareaRef]);
  const priorPartial = useRef(voice.partialText);
  useLayoutEffect(() => {
    if (sessionActiveRef.current && voice.state === "listening" && voice.partialText && voice.partialText !== priorPartial.current) apply(voice.partialText, !anchorRef.current);
    priorPartial.current = voice.partialText;
  }, [apply, voice.partialText, voice.state]);
  const priorFinal = useRef(voice.finalText);
  useLayoutEffect(() => {
    if (sessionActiveRef.current && voice.finalText && voice.finalText !== priorFinal.current) {
      apply(voice.finalText, !anchorRef.current);
      anchorRef.current = undefined;
      sessionActiveRef.current = false;
    }
    priorFinal.current = voice.finalText;
  }, [apply, voice.finalText]);
  const start = useCallback(async () => {
    const node = textareaRef.current;
    if (node) {
      anchorRef.current = { start: node.selectionStart, end: node.selectionEnd };
      // FNXC:VoiceInput 2026-07-24-06:20: Capture a baseline before permission/session startup
      // so a user edit before the first partial is reconciled instead of stale-selection overwrite.
      appliedRef.current = valueRef.current;
    }
    lastPartialRef.current = "";
    sessionActiveRef.current = true;
    await voice.start();
  }, [textareaRef, voice]);
  useLayoutEffect(() => {
    if (voice.state === "error") {
      anchorRef.current = undefined;
      sessionActiveRef.current = false;
    }
  }, [voice.state]);
  useLayoutEffect(() => () => { anchorRef.current = undefined; sessionActiveRef.current = false; }, []);
  const stop = useCallback(async () => {
    // Keep the preview anchor alive while stop flushes the final transcript.
    await voice.stop();
  }, [voice]);
  return { micProps: { enabled: voice.enabled, supported: voice.supported, state: voice.state, error: voice.error, start, stop } };
}
