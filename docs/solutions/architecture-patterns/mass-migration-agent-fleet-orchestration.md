---
title: "Orchestrating a mass code migration with an agent fleet"
date: 2026-06-04
category: architecture-patterns
module: workflow-orchestration
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "A mechanical change must land across hundreds of files (string migration, API rename, codemod-with-judgment)"
  - "Many agents would otherwise contend on one shared artifact (catalog/registry/index file)"
  - "Agent-made changes must be verified against a test suite with pre-existing local failures"
tags:
  - multi-agent
  - workflow
  - i18n-migration
  - test-triage
  - structured-output
---

# Orchestrating a mass code migration with an agent fleet

## Context

The i18n full sweep (PR #1352) migrated ~6,900 strings across 216 files to i18next keys with 6-locale machine drafts, using ~190 subagents over three workflow rounds. The orchestration itself failed twice before working, and the verification phase initially looked like 1,051 test failures. These are the patterns that made it land.

## Guidance

**Partition by file ownership; size batches by work density, not file count.** Build file-disjoint batches from a scouted work-list (grep-count translatable strings per file); heavy files (here ≥40 hits) get a dedicated agent, light files get batched 3–8 per agent. No two agents ever own the same file → no worktree isolation or merge step needed.

**Never let N agents write one shared artifact.** All 60 migrators needed to add keys to the same 20 catalog JSONs. Instead: each agent writes its own fragment file (`/tmp/frags/batch-N.json`) and the orchestrator merges deterministically afterward (with a quote-escaping repair pass — about 1 in 50 LLM-written JSON fragments has unescaped quotes inside values).

**Keep the mechanical change behavior-invariant so tests stay meaningful.** Here: `t("key", "Exact original English")` inline defaults made `en` rendering byte-identical, so the existing suite verified the migration for free.

**Pair every migrator with a read-only verifier, and require honesty fields.** A second-stage agent re-reads the files and reports residuals; the migrator schema includes `files_partial`/`files_skipped`. Round 1 verifiers found 457 residual strings the migrators had claimed done or silently skipped — that report became the exact work-list for round 2 (whose agents also got the regressed test names and self-verified by running them).

**Workflow plumbing that failed before it worked:**
- All 60 agents "completed without calling StructuredOutput" → the prompt must say the FINAL action is the StructuredOutput call and that ending without it discards the work.
- `args` can arrive JSON-stringified → parse defensively: `const A = typeof args === 'string' ? JSON.parse(args) : args`.
- A "loader agent" asked to read the work-list file returned an empty list — pass payloads inline in args, don't delegate orchestration inputs to an agent.
- Concurrency cap below the runtime default: chunked `parallel()` groups with a barrier per chunk (`for (i; i += CHUNK) await parallel(group...)`).

**Triage agent-caused test failures with a clean-baseline diff, not absolute counts.** Run the suite on the branch AND on a clean `origin/main` worktree in the same environment; only the set difference is yours. Here 276 local failures shrank to 23 real regressions (the rest were local-environment fake-timer/`waitFor` hangs that CI's Linux runners never see). Without the baseline, days would have been wasted "fixing" pre-existing noise — with it, CI went green on the first push of the full sweep.

## Why This Matters

Fleet output quality is bimodal: most batches are clean, a predictable tail is partial or subtly wrong (flattened inline JSX markup, helper functions left unmigrated, hook added above an early return). The verify-stage + honesty-fields + round-2 loop converts that tail from "silent regressions" into a bounded, enumerable work-list. And the baseline-diff discipline keeps the operator from drowning in failures the fleet didn't cause.

## When to Apply

- Any 100+-file mechanical migration where per-file judgment is still needed (so a codemod alone won't do).
- Whenever multiple agents must contribute entries to one registry/catalog/index — fragment-and-merge, never shared writes.
- Any time a large agent-made diff meets a test suite that isn't green locally — build the clean-baseline failure set first.

## Examples

Migrator/verifier pipeline stage shape (workflow script):

```js
const results = await pipeline(batches,
  (b) => agent(migratePrompt(b), { schema: MIGRATE_SCHEMA, model: big(b) ? 'sonnet' : 'haiku' }),
  (m, b) => m && agent(verifyPrompt(b, m), { schema: VERIFY_SCHEMA, model: 'haiku' })
            .then((v) => ({ b, m, v })))
```

Baseline-diff triage:

```bash
git worktree add /tmp/main-probe origin/main && (cd /tmp/main-probe && pnpm i && vitest run > baseline.txt)
# delta = failures(branch) − failures(baseline)  → only fix the delta
```

## Related

- `docs/solutions/ui-bugs/skill-autocomplete-highlight-reset-on-swr-revalidation.md` — the "N stabilization passes means product race" rule used during triage
- AGENTS.md → "Fix the Invariant, Not the Repro (FN-5893)"
- PR #1352 — the i18n full sweep this pattern shipped
