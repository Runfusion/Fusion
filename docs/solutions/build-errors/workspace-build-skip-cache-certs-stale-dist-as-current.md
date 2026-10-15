---
title: "Workspace build skips every package and certifies a stale dist as current"
date: 2026-10-15
category: docs/solutions/build-errors
module: scripts
problem_type: build_error
component: build-workspace
symptoms:
  - "`pnpm build` exits 0 and prints `[build-workspace] planned builds: (none)` right after a merge that changed hundreds of files"
  - "`packages/cli/dist/bin.js` keeps the mtime of a days-old deploy build and markers that exist only in the merged code are absent from it"
  - "`.fusion/cache/plugin-build-cache.json` holds many entries with ONE distinct `sourceHash`, all `d337ddb8105f…`"
  - "`[build-workspace] skipped unchanged packages: @runfusion/fusion, @fusion/dashboard, …` names packages whose sources just changed"
root_cause: silent_failure_swallowed
resolution_type: code_fix
severity: high
tags: [build-cache, content-hash, spawnSync, maxBuffer, ENOBUFS, deploy, stale-dist]
---

## What happened

Two production deploys restarted from a stale `dist` while every signal was green. The build
wrapper had planned zero packages because its content-hash cache reported every package
`unchanged`.

## Measured root cause

`scripts/lib/content-hash.mjs` runs git through `spawnSync` **without `maxBuffer`**, whose Node
default is 1,024,000 bytes. This repository's `git ls-files -s` is now **1,101,325 bytes across
10,007 files**, so the repo-wide snapshot spawn died:

```
raw spawnSync: status=null signal=SIGTERM error=ENOBUFS stdoutBytes=1064960
defaultGitRunner(["ls-files","-s"], root) -> NULL
createRepoContentSnapshot(...) -> { trackedByPath: 0, dirty: 0, untracked: 0 }
```

`defaultGitRunner` maps any non-zero status to `null`, and `parseLsFiles(null)` returns an empty
list, so "the scan failed" and "the tree has no files" were the same value. Every package then
hashed the empty set:

```
versionPrefix package-build-v2, zero files -> d337ddb8105f4b9307d12a8114833182ac95a95da262628d9807b3a024b02567
packages/core, packages/engine, packages/cli, packages/dashboard -> all four identical
```

`evaluatePackageBuild` skips when required outputs exist AND `entry.sourceHash === sourceHash`, so
once the poisoned constant was *written*, it matched forever and nothing ever rebuilt again. The
`--force` path was not the writer's bug: it records `computePackageSourceHash`, i.e. the same
constant, which is why the 2026-10-15 RUFU-682 deploy rebuilt the artifact correctly and
re-armed the trap in the same minute (`30 entries, distinct hashes = 1, builtAt
2026-10-15T18:51:07Z`).

Why one checkout looked healthy and another did not: the primary checkout's cache held 29
*distinct real* hashes, so a poisoned run computed the constant, mismatched, and rebuilt
everything — slow but correct. Only a checkout whose cache was **written** by a poisoned run
gets the silent-stale behavior. The timeline also matches: the same two packages hashed
distinctly on 2026-10-05, before the index listing crossed 1 MB.

## The fix

1. `defaultGitRunner` passes `GIT_OUTPUT_MAX_BUFFER` (64 MB); `content-hash.test.mjs` ratchets the
   cap above the repository's real `git ls-files -s` size, so raising the repo past the cap is a
   test failure rather than a stale deploy.
2. The load-bearing change: **an unusable scan is unknown, not empty.**
   `createRepoContentSnapshot` reports `scanFailed`; `computeContentHash` returns `null` for it;
   `computePackageSourceHash` propagates `null`; `evaluatePackageBuild` plans a build with reason
   `git-scan-failed`; and `null` hashes are never persisted. Fail-slow is acceptable, fail-green
   is not.
3. A tripwire for the poisoning signature: if the scan succeeded but every skip shares the
   zero-file digest, `pnpm build` exits 1 with `skip cache is poisoned`
   (`FUSION_BUILD_ALLOW_POISONED_CACHE=1` opts out). Distinct packages have distinct input sets, so
   a real content hash is never shared between two of them.

Legacy poisoned entries self-heal — the first working scan computes a real hash, which mismatches
the stored constant and rebuilds. To clear one by hand:

```bash
rm .fusion/cache/plugin-build-cache.json   # regenerable, ignored build cache
node scripts/build-workspace.mjs --force   # or rebuild once, ignoring the cache
```

## Deploy hygiene that this incident justified

`BUILD_EXIT=0` is not evidence that an artifact is current. Assert a content marker that exists
only in the code being deployed:

```bash
grep -c "capability-declined" packages/dashboard/dist/… packages/cli/dist/bin.js
```

A stale artifact answers `0`. On 2026-10-15 this check is what turned "deploy succeeded" into
"deploy would have shipped a three-day-old build", both before and after the `--force` rebuild.

## Related

- `docs/testing.md` → "An unreadable scan is unknown, never empty (RUFU-565)"
- Cards: RUFU-565 (root cause), RUFU-683 (duplicate intake from the 2026-10-15 deploy)
