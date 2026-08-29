import { useCallback, useEffect, useRef } from "react";

/**
 * FNXC:TouchActionGesture 2026-07-14-00:00:
 * Root cause this hook fixes: on mobile, tapping a button while a nearby text
 * input (e.g. a textarea) still has focus can cause the browser to consume
 * that first touch solely to blur the input and dismiss the on-screen
 * keyboard, suppressing or delaying the resulting synthetic `click` event.
 * The visible symptom is "I have to tap twice" — the first tap only closes
 * the keyboard, and only a second, separate tap actually fires the button's
 * `onClick` handler (FN-7953, reported against the Anthropic manual OAuth
 * code "Submit code" button).
 *
 * This hook generalizes the pattern already proven for the chat Send/Stop
 * button (`useStandardChatActionGesture` in `StandardChatSurface.tsx`),
 * extracted here as a standalone, non-chat-coupled hook so other touch
 * targets (like OAuth manual code submission) can reuse the same fix without
 * importing from or depending on `StandardChatSurface.tsx`. `StandardChatSurface.tsx`
 * keeps its own separate, unmodified implementation — this hook does not
 * replace it, to keep blast radius isolated per FN-7953's Do NOT list.
 *
 * Consumers wire the three returned callbacks onto a button element:
 * - `onPointerDown` (touch pointer types only) / `onTouchStart`: call
 *   `event.preventDefault()`, guard with `beginTouchActionGesture()`, then
 *   `markHandledSendTouch()` before invoking the action immediately — this is
 *   what makes the FIRST tap submit instead of only blurring/dismissing the
 *   keyboard.
 * - `onClick`: call `consumeHandledSendTouch()` first; if it returns `true`
 *   the action was already handled by the touch path above, so skip firing
 *   again (this is what prevents the synthetic click that follows a handled
 *   touch from double-invoking the action).
 * - `onMouseDown`: call `event.preventDefault()` to avoid a mouse-driven
 *   blur race equivalent to the touch case.
 */
export function useTouchActionGesture() {
  // Short-lived "this touch/pointer interaction already fired the action"
  // flag. Read and cleared by consumeHandledSendTouch() inside onClick so the
  // browser's follow-up synthetic click (fired after touchstart/pointerdown)
  // does not invoke the action a second time.
  const handledSendTouchRef = useRef(false);
  const handledSendTouchTimerRef = useRef<number | null>(null);
  // Same-tick re-entrancy guard: onPointerDown and onTouchStart can both fire
  // for a single physical tap on some browsers/devices; beginTouchActionGesture()
  // ensures only the first of that pair proceeds.
  const touchActionGestureRef = useRef(false);

  const markHandledSendTouch = useCallback(() => {
    handledSendTouchRef.current = true;
    if (handledSendTouchTimerRef.current != null) {
      clearTimeout(handledSendTouchTimerRef.current);
    }
    // Auto-clear after 700ms so a later, genuinely separate tap is not
    // silently swallowed if a click event never arrives for some reason.
    handledSendTouchTimerRef.current = window.setTimeout(() => {
      handledSendTouchRef.current = false;
      handledSendTouchTimerRef.current = null;
    }, 700);
  }, []);

  const beginTouchActionGesture = useCallback(() => {
    if (touchActionGestureRef.current) return false;
    touchActionGestureRef.current = true;
    window.setTimeout(() => {
      touchActionGestureRef.current = false;
    }, 0);
    return true;
  }, []);

  const consumeHandledSendTouch = useCallback(() => {
    if (!handledSendTouchRef.current) return false;
    handledSendTouchRef.current = false;
    if (handledSendTouchTimerRef.current != null) {
      clearTimeout(handledSendTouchTimerRef.current);
      handledSendTouchTimerRef.current = null;
    }
    return true;
  }, []);

  useEffect(
    () => () => {
      if (handledSendTouchTimerRef.current != null) {
        clearTimeout(handledSendTouchTimerRef.current);
      }
    },
    [],
  );

  return { beginTouchActionGesture, markHandledSendTouch, consumeHandledSendTouch };
}
