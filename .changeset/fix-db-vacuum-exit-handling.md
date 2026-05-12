---
"@runfusion/fusion": patch
---

Fix `fn db --vacuum` exit handling so successful exits are not caught as VACUUM failures, and await async vacuum errors correctly.
