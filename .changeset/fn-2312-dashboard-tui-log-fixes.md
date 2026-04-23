---
"@runfusion/fusion": patch
---

Fix dashboard TUI log behavior so log navigation can reach all entries still present in the ring buffer and streamed merge output is buffered into log lines instead of writing raw fragments into the interactive terminal UI.