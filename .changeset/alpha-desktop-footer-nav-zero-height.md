---
"@runfusion/fusion": patch
---

summary: Fix the Alpha desktop navigation footer rendering with zero height, making it invisible.
category: fix
dev: `.alpha-desktop-action-bar` renders as a sibling of `.dashboard-project-shell` inside `.dashboard-project-stack`, which does not declare `--executor-footer-height`, so it inherited the `:root` 0px floor for its `block-size`. It now redeclares the token at the consumer like `.terminal-below-host--with-footer`. `footer-safe-layout.test.ts` asserts the general invariant: any rule sizing its own box from the token must declare it.
