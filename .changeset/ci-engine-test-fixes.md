---
"@runfusion/fusion": patch
---

Fix two engine reliability bugs surfaced by CI sharding repair:

- Self-healing in-review branch rebind now dedups case-variant candidate refs by resolved SHA rather than lowercase name, so two distinct branches sharing a case-insensitive name on case-sensitive filesystems (Linux) are correctly flagged as ambiguous instead of one being silently picked.
- CI test sharding: removed the `--` separator between `pnpm test` and `--shard`, which vitest's CLI parser was treating as end-of-flags and turning the shard selector into a positional file filter — silently disabling sharding so every shard ran the full suite. Test shards now run their actual slice.
- CI test-shards jobs now check out with `fetch-depth: 0` so engine tests that depend on real git history (merge-base, ref resolution) behave the same on CI as locally.
- PR Checks workflow now also runs on push to `main`, so post-merge regressions surface immediately instead of waiting for the next PR.
