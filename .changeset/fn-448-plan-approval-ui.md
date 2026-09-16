---
"@runfusion/fusion": patch
---

summary: Tasks waiting for your plan decision show one decision surface and a blinking "Needs you" badge.
category: fix
dev: Removes the duplicated footer `HumanPlanApprovalControls` placement (the `variant` union is now `banner` only) and the full-card `plan-approval-notice--card` overlay with its render. Adds `tasks.planApproval.needsYouBadge`, mapped by TaskCard and both ListView renders in place of `tasks.awaitingApproval`, painted with warning tokens plus a `needs-you-blink`/`list-needs-you-blink` animation cancelled under `prefers-reduced-motion`. Both List notices now receive `onOpenTaskRecord`.
