---
"@runfusion/fusion": patch
---

Make agent pause/resume state transitions act immediately by stopping active heartbeat runs on pause and triggering an on-demand heartbeat on resume.