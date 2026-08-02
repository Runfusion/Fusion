---
"@runfusion/fusion": patch
---

summary: Fix uneven right padding on tablet task/terminal popups; drag the terminal from anywhere in its toolbar.
category: fix
dev: Tablet-mode FloatingWindows (`.floating-window--tablet-viewport`) zero the FN-8015 scrollbar gutter; GitHub-import detail compensates locally. Terminal tab-strip empty space now bubbles to the `.terminal-header` drag handle (`touch-action: none` on the tablet floating header supersedes the FN-8633 pan-x contract).
