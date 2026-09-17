---
"@runfusion/fusion": patch
---

summary: Quick Add now needs a slightly longer Save hold (0.6s) before it starts the task.
category: fix
dev: `QUICK_ADD_START_HOLD_DURATION_MS` in `QuickEntryBox.tsx` goes from 500 ms to 600 ms (+20%). The engage delay stays at 150 ms, so a brief click is still an ordinary Save and the progress ring simply fills over the remaining 450 ms, still reaching 100% exactly at Start. The timing constants are now named exports so tests reference them instead of copying literals.
