---
"@runfusion/fusion": minor
---

summary: Remove the pre-commit diff-volume merge gate; approved squashes are no longer blocked on per-file shrinkage.
category: feature
dev: Deletes `checkDiffVolume`/`DiffVolumeRegressionError`, the `merge:diff-volume-blocked` audit event, and the `mergeDiffVolumeMinLines`/`mergeDiffVolumeThreshold`/`mergeDiffVolumeAllowlist` settings. File scope remains the pre-land guard; the post-squash audit policy remains the shrinkage backstop.
