---
"@runfusion/fusion": patch
---

Harden the publish path against dockerode-class missing-dependency regressions (#33). Adds a generalized invariant test that walks `tsup.config.ts` and asserts every non-builtin `external` is either a runtime dep or in an explicit transitive-allowlist, plus a pre-publish smoke step in `pnpm release` that packs the public tarballs, installs them with plain `npm` into a clean temp dir, and invokes the bin — catching the dockerode-class bug (and others like missing `files` globs) before publish, since pnpm hoisting masks it in the workspace.
