---
"@runfusion/fusion": patch
---

summary: Quick Add action buttons are no longer shrunk in shadcn themes.
category: fix
dev: Pins the .quick-entry-actions control height to literal :root tokens (28px desktop / 36px mobile) so shadcn's tighter --space-xl/--space-2xl scale no longer shrinks the composer (desktop + mobile).
