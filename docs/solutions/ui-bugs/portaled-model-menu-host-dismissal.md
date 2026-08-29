---
category: ui-bugs
module: dashboard model selection
tags:
  - portals
  - dialogs
  - mobile
  - model-picker
problem_type: interaction-dismissal
applies_when: A document.body portal is logically owned by a dialog, popover, or panel with outside-dismiss behavior.
---

# Keep portaled model menus inside their host interaction boundary

`CustomModelDropdown` renders its listbox in `document.body` to escape clipping. DOM containment alone therefore misclassifies menu gestures as outside a host dialog or popup. On mobile, virtual-keyboard re-anchoring can make a gesture that starts in the filter input release or synthesize a click on the backdrop.

Use `isInsidePortaledModelMenu()` or `isInsidePortalSafeSurface()` from `app/utils/portalSurfaces.ts` for document-level dismissal handlers. Do not duplicate portal class-name selectors in host components. Backdrops that dismiss must use `useOverlayDismiss`, which pairs the press origin with the release before closing.

The dropdown boundary stops pointer, mouse, and touch start/end events, but deliberately does not stop `click`; React option and favorite handlers require clicks dispatched through the portal. Regression coverage must exercise desktop and mobile press-origin sequences, including a release on the host backdrop.
