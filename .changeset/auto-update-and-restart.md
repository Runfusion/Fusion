---
"@runfusion/fusion": minor
---

summary: Add opt-in auto-update and make the post-update Restart button report why it was refused.
category: feature
dev: New global setting `autoUpdateAndRestart` (default false, Settings → General next to Release channel) drives `startAutoUpdateWatcher` in the dashboard server — channel-aware check + `performUpdateInstall` + `systemControl.requestRestart`, supervised hosts only. The supervisor now stamps `FUSION_SUPERVISOR_PID` and `hasLiveSupervisingParent()` verifies it against `process.ppid`, so an inherited `FUSION_RESTART_SUPERVISED` (agent terminals, dev servers) no longer suppresses self-supervision or fakes restart support. Settings and the update banner probe `/system/info` on mount and treat capability as advisory: the restart button always issues the request and surfaces the server's refusal instead of sitting disabled.
