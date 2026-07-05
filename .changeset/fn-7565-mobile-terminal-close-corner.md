---
"@runfusion/fusion": patch
---

summary: Pin the mobile terminal close (X) button to the top-right corner so it is easy to find and tap.
category: fix
dev: On the ≤768px terminal, the `terminal-close` button now carries a `terminal-close--corner` class (order:3 + margin-inline-start:auto) so it renders last in flex order and hugs the right edge next to the tab dropdown, instead of falling back to order:0 (far left). Desktop/floating/pinned-below placement inside `.terminal-actions` is unchanged.
