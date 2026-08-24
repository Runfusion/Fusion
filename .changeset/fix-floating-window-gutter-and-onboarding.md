---
"@runfusion/fusion": patch
---

summary: Fix uneven right/bottom space around floating windows and drop the remote-server prompt from browser onboarding.
category: fix
dev: Deletes FN-8015's shared `margin-inline-end` gutter on `.floating-window__body` plus its five piecemeal zeroing overrides and GitHub Import's borrowed-inset compensation; a scrollbar/resize-target collision is now fixed per-caller with FN-8766's outboard east handles. The hosted Set Up AI modal re-asserts `width/height: 100%` under `.floating-window--model-onboarding` (its standalone `85vh` rule tied on specificity and won on source order). The "Connect remote Fusion server" card now also requires `shellState.host !== "web"` — `desktopMode` is undefined in a browser, so web first-run showed a native-shell hand-off form.
