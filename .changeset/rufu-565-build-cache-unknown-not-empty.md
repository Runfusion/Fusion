---
"@runfusion/fusion": patch
---

summary: `pnpm build` can no longer certify a stale dist as current after an unreadable git scan.
category: fix
dev: Content hashes are `unknown` (null) when `git ls-files`/`git status` fail, so those packages always rebuild with build reason `git-scan-failed`; `defaultGitRunner` now passes a 64 MB maxBuffer (Node's 1 MB default truncated this repo's 1.1 MB index listing with ENOBUFS, which hashed every package to one shared digest and made the skip cache certify a days-old dist as `unchanged`). If the scan succeeds yet every skip shares that zero-file digest, the build now exits 1 with `skip cache is poisoned`; clear it with `rm .fusion/cache/plugin-build-cache.json` or one `pnpm build --force`, and `FUSION_BUILD_ALLOW_POISONED_CACHE=1` opts out of the refusal. Verify a deployed artifact by grepping a marker unique to the new code, not by `BUILD_EXIT=0`.
