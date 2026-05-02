---
"@runfusion/fusion": patch
---

Fix pause handling so restarted or paused engines do not resume work or move recovered tasks into review until execution is resumed, including workflow-step and completion handoff paths.
