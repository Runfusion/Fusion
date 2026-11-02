---
"@runfusion/fusion": patch
---

summary: Stuck scheduler passes now name which project's board stalled and which leg it reached.
category: internal
dev: `schedule watchdog: previous pass still marked in-flight after Ns` gains `(project=<root> leg=<leg>)`, legs are board-read / mission-symbol-locks / hold-release-sweep / post-sweep-reread / advisory-reporters, and a pass slower than 30s logs one `schedule pass finished in Ns` line. No lifecycle behaviour changes; the guard, its 600s threshold, and every dispatch decision are untouched.
