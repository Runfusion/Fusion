---
"@runfusion/fusion": patch
---

summary: Fix cramped GitHub/GitLab import detail header and show translated titles in its title bar.
category: fix
dev: Detail panel now owns a symmetric inset (right side still supplied by the FN-8015 `.floating-window__body` resize gutter — do not override that margin). Header uses a label + right-aligned action cluster instead of `space-between`, and both actions size from one rule (30px desktop / 40px mobile touch target). `.floating-window__title` switched from `display:flex` to `block` so its already-declared `text-overflow: ellipsis` actually applies — every caller passes a string title. Detail window titles read `importTranslation.display.title`, gated on `activeTab` to match `translateSelection`.
