---
"@gsxdsm/fusion": patch
---

Auto-select first available model in quick chat when no agents exist

When opening the quick chat popup with no agents configured, the component
automatically switches to "Model" mode but previously showed "Use default"
with no actual model selected. This left the input disabled because no valid
chat target existed.

Now when models load and there are no agents, the first available model is
automatically selected, allowing the user to immediately start typing messages.
