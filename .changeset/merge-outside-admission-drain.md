---
"@runfusion/fusion": patch
---

summary: Planning admission no longer freezes for the duration of every merge.
category: fix
dev: Root cause of the 5-10 min "Queued to plan" stalls — the merge lane ran the entire merge inside projectAdmissionCoordinator's single-flight drain, so triage's poll parked awaiting it (and its re-entrance guard then dropped every tick silently). The lane start now claims and returns; the merge body runs outside the drain. No automated regression test yet — the drain-blocking shape needs a project-engine harness; the triage poll watchdog (e51ebff381) is the backstop meanwhile.
