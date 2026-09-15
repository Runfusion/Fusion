---
"@runfusion/fusion": patch
---

summary: History now opens as one window over your board instead of two competing displays.
category: fix
dev: Removes the `taskView === "patchnode"` main-content page and the desktop pilot-window host. History is a `useModalManager` surface (`historyOpen`/`openHistory`/`closeHistory`) rendered once by `AppModals`; a `patchnode` view request is coerced to Board and opens the modal.
