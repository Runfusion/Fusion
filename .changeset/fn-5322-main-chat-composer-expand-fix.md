---
"@runfusion/fusion": patch
---

Fix main chat composer (direct chat and rooms) so it visually grows on
multi-paragraph paste up to the 640px cap, matching QuickChat behavior.
The 640px cap from FN-5146 was already in place but an ancestor layout
constraint was clipping the rendered height.
