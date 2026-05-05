---
"@runfusion/fusion": patch
---

feat(tui): up/down arrows now cycle sections on the Main page (matching ←/→), except on the Logs panel where they continue to navigate log entries. Pressing Enter on a Logs entry now also releases xterm mouse reporting while the entry is expanded, so users can click-drag to select log text for copying; closing the expanded view restores wheel scrolling automatically.
