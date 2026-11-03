---
"@runfusion/fusion": patch
---

summary: Stop the merge gate re-announcing the same refusal every pass.
category: fix
dev: The merge-lane unrun-gate arm re-emitted `task:merge-unrun-pre-merge-gate-rerouted` on every pass; measured 23 identical `active-continuation` rows in 12 minutes for one card. It now reuses the RUFU-431 bounded-refusal seam (`shouldEmitUnrunPreMergeGateNotice`), so a refusal is recorded on the transition into it (reason, named gate, or required-gate count changed) and real re-seeds always write.
