---
"@runfusion/fusion": patch
---

summary: Mobile board swipes now glide one column at a time and land exactly on a column.
category: fix
dev: `useColumnScrollSnap` drops the velocity/travel derived multi-page quota (`resolvePageCount`, `resolveFlingTargetIndex`, `resolveSettleTargetIndex`, `resolvePageAnimationMs` and their constants) and commits a single distinct neighbour anchor over one 280ms ease-in-out transition started from the release position. Snap targets are now direct `.column` children only — the previous "fewer than two columns falls back to every child" path is removed — and every target is a range-clamped reachable `scrollLeft`. Desktop/tablet free scrolling, reduced motion, wheel bursts, and the FN-398 bounded compositor pin are unchanged; `restoreBoardScrollSnapshot` now emits `fusion:board-scroll-restore` before writing so the hook yields the axis.
