---
title: "OAuth manual code mobile double-tap submit"
date: 2026-07-14
category: ui-bugs
module: packages/dashboard/app/components/OAuthManualCodeForm
problem_type: ui_bug
component: frontend_auth_onboarding
symptoms:
  - "On mobile, tapping \"Submit code\" for a manual OAuth code (e.g. Anthropic subscription OAuth) while the textarea still has focus only dismisses the on-screen keyboard on the first tap"
  - "onSubmit does not fire until a second, separate tap lands on the button"
  - "Desktop mouse-click submission is unaffected — only touch/mobile browsers exhibit the double-tap requirement"
root_cause: touch_event_ordering
resolution_type: code_fix
severity: medium
related_components:
  - packages/dashboard/app/hooks/useTouchActionGesture.ts
  - packages/dashboard/app/components/OAuthManualCodeForm.tsx
  - packages/dashboard/app/components/StandardChatSurface.tsx
  - packages/dashboard/app/components/settings/sections/AuthenticationSection.tsx
  - packages/dashboard/app/components/ModelOnboardingModal.tsx
  - FN-7953
tags:
  - touch-events
  - mobile-double-tap
  - oauth
  - keyboard-dismiss
  - gesture-handling
  - onboarding
---

# OAuth manual code mobile double-tap submit

## Problem

On mobile/touch viewports, `OAuthManualCodeForm`'s "Submit code" button relied solely on a plain `onClick={onSubmit}` handler. When the user typed or pasted a manual OAuth code (Anthropic subscription OAuth, or any other provider using `manualCodeConfigs`) and tapped "Submit code" while the textarea still held focus, some mobile browsers consumed that first physical tap solely to blur the focused textarea and dismiss the on-screen keyboard — suppressing or delaying the resulting synthetic `click` event. The button's `onClick` handler did not fire until a second, separate tap landed on the same button, so users had to tap "Submit code" twice to actually submit their auth code.

This is the same mobile-web event-ordering bug class already solved for the chat Send/Stop button (`useStandardChatActionGesture` + `StandardChatActionButton` in `StandardChatSurface.tsx`), but `OAuthManualCodeForm` had not been wired up to that pattern.

## Solution

Extracted the proven gesture-handling logic from `useStandardChatActionGesture` into a new, generic, non-chat-coupled hook, `useTouchActionGesture()` (`packages/dashboard/app/hooks/useTouchActionGesture.ts`), and wired it into `OAuthManualCodeForm`'s submit button:

- `onPointerDown` (touch pointer types only, via `event.pointerType !== "mouse"`) and `onTouchStart` both call `event.preventDefault()`, guard with `beginTouchActionGesture()` (a same-tick re-entrancy guard so a single physical tap that dispatches both `pointerdown` and `touchstart` only fires the action once), then `markHandledSendTouch()` and invoke `onSubmit()` immediately (when not `disabled`) — this is what makes the *first* tap submit instead of only dismissing the keyboard.
- `onMouseDown={(event) => event.preventDefault()}` avoids an equivalent mouse-driven blur race.
- `onClick` calls `consumeHandledSendTouch()` first; if it returns `true` the tap was already handled via the touch path above, so the synthetic click that follows is skipped — preventing a double `onSubmit` invocation for one physical tap. Otherwise (a genuine non-touch/mouse click, or a touch environment where the touch handlers didn't fire) it calls `onSubmit()` directly when not `disabled`.
- `style={{ touchAction: "manipulation" }}` on the button avoids double-firing from the browser's native double-tap-to-zoom gesture handling, matching `StandardChatActionButton`.

`StandardChatSurface.tsx` and its existing `useStandardChatActionGesture`/`StandardChatActionButton` were left untouched — the new hook is a standalone extraction so non-chat consumers can reuse the same fix without depending on the chat component, keeping blast radius isolated to auth-code submission. Because the fix lives in the shared `OAuthManualCodeForm` component (rendered by both `AuthenticationSection.tsx`'s Settings → Authentication tab and `ModelOnboardingModal.tsx`'s onboarding "Connect AI providers" flow), every manual-OAuth-code provider inherits the single-tap fix without any caller changes.

## Regression coverage

`OAuthManualCodeForm.test.tsx` covers the invariant, not just the reported repro:

- Mobile single-tap: `matchMedia` mocked mobile, textarea focused, then the real mobile browser sequence (`touchstart` → `blur` on the textarea → `click`) is dispatched once and `onSubmit` is asserted to have fired exactly once.
- Duplicate event dispatch for one physical tap: `pointerdown` (`pointerType: "touch"`) and `touchstart` both fired for the same tap, followed by `click`, still yields exactly one `onSubmit` call — proving the same-tick re-entrancy guard prevents double-firing when a browser dispatches both event families for one gesture.
- Desktop/non-touch regression: mobile `matchMedia` not matched, a plain `click` with no preceding touch/pointer events still submits exactly once — proving mouse-driven desktop submission is unaffected.
- `disabled` state: the same touch/pointer/click sequence never invokes `onSubmit` while `disabled` is true, from any path.
- The two pre-existing `scrollIntoView` viewport-assist tests continue to pass unmodified, proving the mobile keyboard viewport-assist behavior is untouched by this fix.

`useTouchActionGesture.test.ts` unit-tests the hook directly: `beginTouchActionGesture()` returns `true` once and `false` on a same-tick re-entrant call (with fake timers proving it clears on the next tick); `markHandledSendTouch()` sets a flag that `consumeHandledSendTouch()` reads and clears exactly once; the handled flag auto-expires after its ~700ms timeout; and the pending timer is cleared on unmount.
