---
"@runfusion/fusion": patch
---

summary: Rename downloadable CLI release binaries to the fn-cli-<platform> base name.
category: internal
dev: `binaryNameForTarget` in `packages/cli/build.ts` and the `release.yml` / `test-release.yml` matrices now emit `fn-cli-<suffix>`; the local dev binary stays `fn`/`fn.exe`.
