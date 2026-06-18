---
"@runfusion/fusion": patch
---

Fix completed tasks being parked failed in in-review with a spurious "engine abort during pause/resume — operator action required" error (FN-6648; recurrence of FN-6478/FN-6568/FN-6625/FN-6644/FN-6647). The paused-after-completion graceful-exit path finalizes a fully completed task to in-review while leaving a non-user `paused` flag set; `handleGraphFailure`'s completion-finalized guards required `paused !== true`, so the trailing graph failure was misclassified as an operator-action pause abort once the volatile completion markers were lost. The classifier now recognizes finalized completions regardless of a lingering non-user pause flag, while genuine user/global pauses and in-progress tasks are unaffected.
