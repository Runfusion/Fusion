---
title: FN-9477 ProviderIcon catalog coverage
---

# FN-9477 ProviderIcon catalog coverage

## Source symptom

- Full Suite source run: [37224597752](https://github.com/Runfusion/Fusion/actions/runs/37224597752) at `58244ab3c56abf2003cb6c21d447b7ef30af8401`.
- Failed job: [Test shard 4/4, 111501536133](https://github.com/Runfusion/Fusion/actions/runs/37224597752/job/111501536133).
- Timing artifact: [test-timings-shard-4, 11312041835](https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/11312041835/zip).
- The failed assertion was `ProviderIcon > ratchets every catalog-derived and enumerated first-class ID to an accessible non-Cpu mark`: catalog-derived `meta` rendered the Lucide CPU fallback, which has no branded `data-testid`.

## Cause and repair invariant

FN-9340 (`50d9976a05`) added `meta` / Meta (Muse) to both `STATIC_OAUTH_PROVIDER_CATALOG` and `STATIC_API_KEY_PROVIDER_CATALOG`. The static-catalog union deduplicates that input, but `ProviderIcon` had no canonical `meta` entry and therefore resolved it as an unknown provider.

`ProviderIcon` now maps `meta` to its dedicated tokenized Meta Muse SVG mark. The mark has the stable `meta-icon` test ID and accessible name, while case normalization and the genuine unknown/empty Lucide CPU fallback remain unchanged. Authentication settings and model onboarding consume this shared component, so no host-specific icon implementation is needed.

## Focused verification

Passed from the dashboard's owning quality project (the `ProviderIcon` file is in `dashboard-app-quality-components-b`):

```text
pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app-quality-components-b app/components/__tests__/ProviderIcon.test.tsx --silent=passed-only --reporter=dot
```

Result: 119 tests passed. Coverage includes Meta's catalog-derived deduplication, branded accessible non-CPU output, normalized provider input, all shared sizes, and the retained unknown and empty CPU fallback.

Additional required local checks passed: `pnpm lint`, `pnpm verify:fast`, and `pnpm build`.

## Hosted follow-up

A qualifying hosted Full Suite run cannot exist until the repair commits land on `main`. After landing, record the first push-to-main Full Suite at or after the landed SHA, its shard-4 job URL in the form `https://github.com/Runfusion/Fusion/actions/runs/<run-id>/job/<job-id>`, and its `test-timings-shard-4` artifact URL in the form `https://api.github.com/repos/Runfusion/Fusion/actions/artifacts/<artifact-id>/zip`. Until then, the source run and focused local result above are evidence of diagnosis and repair, not hosted-pass evidence.
