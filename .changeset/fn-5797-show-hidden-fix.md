---
"@runfusion/fusion": patch
---

Fixes the UsageIndicator popup hidden-window recovery flow by preventing hide/show controls from acting as implicit form-submit buttons.

- Sets the per-window hide control and provider-level **Show hidden (N)** control to `type="button"` so they do not trigger parent form submits.
- Adds a regression test that verifies clicking **Show hidden** reveals hidden windows, persists the unhidden state, and remains correct after rerender/state re-sync.
