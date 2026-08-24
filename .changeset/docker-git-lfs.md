---
"@runfusion/fusion": patch
---

summary: The Docker image now ships git-lfs, so LFS-tracked files check out as real content instead of stubs.
category: fix
dev: The repository stores binary assets (screenshots) as Git LFS objects, but the runner stage installed plain `git`. Without git-lfs, `git checkout`/`clone` writes ~130-byte pointer files in place of the real content AND reports a clean tree — an agent reading one gets a text stub where an image should be, and any `git lfs` subcommand fails outright. Verified in the running container: `screenshots/fn-061-medieval-desktop.png` was a `version https://git-lfs.github.com/spec/v1` stub across 129 tracked files, and became a valid 753KB PNG after installing git-lfs and running `git lfs pull`. Added to the runner apt install alongside git, with the Dockerfile manifest guard extended so it cannot be dropped again.
