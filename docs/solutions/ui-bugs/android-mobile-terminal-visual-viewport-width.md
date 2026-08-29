---
category: ui-bug
module: dashboard-terminal
tags: [android, mobile, visualViewport, xterm, keyboard]
problem_type: layout-regression
applies_when: Terminal or xterm surfaces render in a mobile shell while Android Chrome reports a visualViewport narrower than the layout viewport.
---

# Android terminal spacing with keyboard-open visualViewport width

## Problem

Android Chrome can keep `window.innerWidth` at a tablet/layout width while `window.visualViewport.width` is the narrow visible pane with the soft keyboard open. If a terminal switches to mobile UI from the visual viewport but sizes the modal or keyboard tracking from the layout viewport, xterm can fit against a stale wide box and render ASCII filenames with excessive spacing/wrapping at small persisted font sizes such as 10px.

## Fix pattern

- Treat touch-primary `visualViewport.width` as part of mobile detection for terminal keyboard handling.
- Publish both `--vv-height` and `--vv-width` while keyboard overlap is present.
- Apply keyboard-constrained terminal sizing on the explicit mobile class, not only inside `@media (max-width: 768px)`, because CSS media queries still see the layout viewport.
- Keep xterm's measured `fontFamily` symbols-free and verify 10px font preferences still trigger fit/resize/refresh.

## Regression command

```bash
pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/TerminalModal.test.tsx app/components/__tests__/SessionTerminal.mobile.test.tsx app/hooks/__tests__/useMobileKeyboard.test.ts --silent=passed-only --reporter=dot
```
