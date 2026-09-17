---
category: ui-bugs
module: packages/dashboard/app
tags:
  - mobile
  - keyboard
  - visual-viewport
  - layout
  - ios
  - android
problem_type: layout-race
applies_when:
  - A field is covered by the soft keyboard on a phone
  - An empty band appears between the soft keyboard and the focused field
  - Keyboard layout behaviour differs between two attempts with the same steps
  - You are about to add a keyboard offset, margin, or delay to a mobile surface
---

# One measurement, one owner: soft-keyboard geometry on mobile

## Symptom

> "Quand j'ouvre des inputs sur mobile, notamment le chat, et que mon clavier virtuel s'ouvre, 1 fois
> sur 2 c'est buggué. Soit je vois le clavier par dessus l'input, soit je vois un gros espace entre
> mon clavier et l'input."

Two *opposite* failures, alternating on the same device with the same steps. That alternation is the
diagnosis: a single wrong constant produces one consistent error, whereas two failure modes that swap
places mean several pieces of code are adjusting the same rectangle and the winner depends on the
order the browser happened to deliver its events in.

## Verified causes

### 1. Several owners compensating for the same keyboard

For Chat on a phone, all of these ran at once:

- `MobileDrawer` sized its panel from `--mobile-drawer-block-size`, derived from `100dvh`;
- `ChatView` clamped `.chat-thread` to `--vv-height` minus a measured thread top;
- `ChatView` also applied `transform: translateY(offsetTop)` to the same element;
- `.chat-thread--keyboard-active .chat-input-area` added a constant iOS margin;
- the drawer body additionally reserved `--mobile-nav-system-offset`.

Each was individually defensible. Together they are a race. `100dvh` does **not** shrink when the
keyboard opens on WebKit, so the panel stayed full height and could hold the composer under the
keyboard; when the inner clamp won instead, its subtraction stacked with the drawer's reserve and the
composer floated far above the keyboard.

### 2. Placement computed from a heuristic instead of a measurement

`ChatView` computed `window.innerHeight - vv.offsetTop - vv.height`, and `useMobileKeyboard`'s iOS
branch computed the occluded band from a cached *baseline* height. Both are wrong in the Android case:
with `interactive-widget=resizes-content` (which `app/index.html` sets) the layout viewport shrinks
with the keyboard, so nothing is occluded and the correct reservation is **zero** — but a baseline
captured before the keyboard still reports a few hundred pixels. That reservation *is* the empty band.
`window.innerHeight` compounds it: Android Chrome can report a stale value while
`document.documentElement.clientHeight` has already been reduced.

### 3. A constant standing in for a measurement

`--chat-keyboard-accessory-clearance` added roughly 48px below the composer whenever an iOS keyboard
was believed to be up. It measured nothing. It was introduced for Safari's input-assistant bar, but it
applied whether or not that bar was present and whether or not the visual viewport already excluded it.

### 4. Fixed delays standing in for convergence

A 450ms suppression window, a 350ms deferred scroll reset, and a tail of updates at
50/200/500/1000/1500ms per mounted consumer. A fast close-then-refocus outruns them, and N mounted
surfaces each ran their own copy, so two surfaces could publish two different answers for one instant.

## The rule

**The canonical datum is the visible rectangle in layout coordinates.**

```
visibleBottom        = visualViewport.offsetTop + visualViewport.height
residualBottomInset  = max(0, layoutHeight - visibleBottom)   // layoutHeight is document-first
```

This is the same coordinate space `getBoundingClientRect()` reports, so a container can be compared
against it directly. It is correct in both browsers without branching on the user agent:

| | layout viewport | visual viewport | residual inset |
| --- | --- | --- | --- |
| iOS / WebKit | unchanged | shrinks | the occluded band |
| Android `resizes-content` | shrinks | shrinks | `0` |

Three corollaries, all of which were violated before:

1. **A baseline may qualify a transition; it may never supply placement pixels.** Detection ("is a
   keyboard up?") is genuinely heuristic and needs a baseline. Placement is not, and must not use one.
2. **A container adapts from its OWN geometry, matched to how it is anchored.** Not from a keyboard
   height applied blindly. Two anchoring shapes need two different stable answers:
   - *Top-anchored* (a floating window positioned by `top`, a region in normal flow): its top edge does
     not move when its height changes, so cap the height at `visibleBottom - top`.
   - *Bottom-anchored* (the mobile drawer overlay, `inset: 0` with a bottom-aligned panel): shortening
     it moves its own top, so a height derived from that top **feeds back into itself**. Adapt the
     bottom INSET straight from the frame instead — no element measurement, no feedback path.
   Getting this wrong is not an off-by-some-pixels error. Measured in real Chromium, deriving the
   drawer's height from its current top collapsed the panel 832px → 144px → 1px over successive
   observations, each pass shrinking the box it was measuring.
3. **Exactly one container per surface adapts.** Ownership is published through React context
   (`KeyboardViewportOwnerProvider`); a descendant inside an adapted ancestor adapts nothing.
4. **Ownership is only claimed when an adaptation is actually applied.** A container that publishes
   `owned: true` silences its whole subtree, so a claim that the cascade then ignores is worse than
   no claim at all. On a phone, `FloatingWindow` is re-presented as a drawer whose `height` and
   `max-height` are `!important`, which beats an inline cap, and whose overlay bottom-aligns its
   panel: that presentation is therefore adapted through the overlay's bottom edge exactly like
   `MobileDrawer`, and the ordinary window keeps the measured inline cap. Hosted forms
   (Settings, Git, Mailbox, interviews) read `useKeyboardViewportOwnedByAncestor()` and publish no
   `--keyboard-overlap`/`--vv-offset-top` when a host already adapted the same rectangle.
5. **Document-global keyboard effects follow the ACTIVE surface.** `keyboardOpen` is derived from
   `document.activeElement`, so a retained-but-hidden Chat would otherwise pin the body and cancel
   touch gestures as soon as a field in a visible form took focus.

## Implementation

| Concern | Owner |
| --- | --- |
| Atomic frame + shared subscription | `app/utils/mobileKeyboardViewport.ts` |
| Heuristic detection, navigation lifetime | `app/hooks/useMobileKeyboard.ts` |
| Container adaptation + ownership | `app/hooks/useKeyboardViewportSurface.ts` |
| Local reveal of a focused control | `app/utils/scrollFocusedControlWithin.ts` |
| Adapting containers | `MobileDrawer`, `FloatingWindow`, `TerminalModal` |

The frame carries focus alongside geometry so both describe the same instant — otherwise a blur that
changes no pixels is deduplicated away and consumers stay stuck keyboard-up for the whole dismissal.
A physically impossible sample (`offsetTop + height > layoutHeight`) is held, not published, while a
bounded and cancellable stabilization poll runs; a leftover `offsetTop` reported alongside a height
that already fills the layout viewport is normalized to zero, because no other geometry is consistent
with it.

## Rejected approaches, and why

| Approach | Why not |
| --- | --- |
| `navigator.virtualKeyboard.overlaysContent` | [Experimental, Chromium-only](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API). It disables the browser's own adaptation, so it would make Safari worse while fixing nothing there. |
| `100dvh` everywhere | [WebKit #292603](https://bugs.webkit.org/show_bug.cgi?id=292603) reports the bottom empty band persisting with `dvh` and constrained overflow. `dvh` does not track the keyboard on WebKit. |
| A tuned accessory-bar constant | A constant cannot know whether the bar is present or already excluded from `visualViewport.height`. Replacing one magic number with another reproduces the bug at a different size. |
| Longer or additional settle delays | The intermittency came from concurrent writers, not from sampling too early. More delay makes the wrong answer arrive later. |
| A user-agent test | The correct behaviour follows from which viewport the browser resized, which is directly observable. |

## Testing this area

- **jsdom performs no layout.** `getBoundingClientRect()` returns all zeros, so a container-geometry
  test must supply the rectangle it pretends to measure (`stubMeasuredRect`, `stubBoundingRect`).
  A jsdom test proves published state, ownership, and cancellation — never a rendered result.
- **Drive metric pairs, not a "keyboard".** `app/test/mobileKeyboardViewport.ts` lets layout and visual
  heights disagree, which is the whole point: a fixture that shrinks `window.innerHeight` in lockstep
  with `visualViewport.height` describes a state in which the correct reservation is zero, and an older
  version of `useMobileKeyboard.test.ts` did exactly that while asserting a non-zero one.
- **Assert the resting state too.** Most regressions here are a value that is never cleared. Every
  transition test should end with close → resting geometry restored exactly.
- **Real Chromium for rendered geometry**
  (`packages/dashboard/src/__tests__/mobile-keyboard-browser.test.ts`) drives simulated viewport
  metrics against real CSS. It does not raise a real keyboard, and no automated lane here does.

## Related

- [`mobile-keyboard-restore-stale-viewport.md`](mobile-keyboard-restore-stale-viewport.md) — recovery
  after background/restore.
- [`quick-chat-mobile-keyboard-board-shift.md`](quick-chat-mobile-keyboard-board-shift.md) — keeping
  the background isolated from an overlay's keyboard.
- [`tablet-keyboard-viewport-mode-flip.md`](tablet-keyboard-viewport-mode-flip.md) — a tablet keyboard
  must not reclassify the device as a phone.
