---
"@runfusion/fusion": patch
---

summary: Task description no longer traps scrolling at its end, and its box is half as tall.
category: fix
dev: `.detail-definition-description-body` in `TaskDetailModal.css` now declares `overscroll-behavior: auto` instead of `contain`, and its height fallbacks drop from 18rem/12rem to 9rem/6rem.
