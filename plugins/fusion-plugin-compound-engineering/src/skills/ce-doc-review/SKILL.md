---
name: ce-doc-review
description: "Review Compound Engineering markdown or HTML plan documents for coherence, feasibility, and scope alignment. Use headless mode for automated plan handoff review; HTML uses DOM-safe mutation only when proven safe, otherwise report-only."
argument-hint: "[mode:headless] <plan-or-requirements-path>"
---

# CE Document Review

Review a Compound Engineering markdown or HTML plan/requirements document. Markdown artifacts may receive safe markdown-only fixes; HTML artifacts may receive only the DOM-safe mutations proven by the FN-7149 helper and otherwise remain report-only with no mutation.

<!--
FNXC:CompoundEngineering 2026-06-27-00:00:
FN-7147 requires HTML artifacts to receive the same persona-lens document review as markdown artifacts while suppressing markdown-based in-file mutation. FN-7149 permits only DOM-safe HTML mutations after parse5 round-trip, anchor, protected-region, visible-text, and atomic-write validation; any safety failure preserves the report-only path because markdown edit mechanics would corrupt rendered HTML plans.
-->

## Modes

- `mode:headless <path>`: run an automated advisory pass and return a concise review envelope. For markdown, apply only `safe_auto` markdown fixes; for HTML, attempt only the allowlisted DOM-safe helper operations and fall back to report-only (`fixes_applied = 0`) whenever safety cannot be proven.
- `<path>` without `mode:headless`: run the same review for an interactive caller. For markdown, include actionable findings clearly enough for the caller to decide what to apply; for HTML, present findings with DOM-safe mutation status and do not offer markdown apply-set or markdown Append-to-Open-Questions write-back options.

## Review boundary

`ce-brainstorm` owns WHAT: product requirements, actors, flows, acceptance examples, and scope boundaries.

`ce-plan` owns HOW: technical decisions, implementation units, dependencies, risks, verification contract, and handoff posture.

`ce-doc-review` checks whether the document preserves that boundary and is usable by downstream `ce-work`, PR reviewers, and humans. Do not turn document review into code review; `ce-code-review` owns implementation diff review later in the pipeline.

## Procedure

1. Resolve the target path from the arguments. Prefer an explicit path. If no path is provided, inspect `docs/plans/` for the most recent markdown (`.md`) or HTML (`.html`) plan-like artifact and use that; if none exists, skip non-blockingly.
2. Classify the target type:
   - Markdown (`.md`): review with markdown-safe mutation enabled for `safe_auto` fixes only.
   - HTML (`.html`): review with DOM-safe mutation enabled only for the FN-7149 allowlist: append to an existing Open/Outstanding Questions list, provable stable-registry heading-depth repair, duplicate inter-block whitespace normalization, and exact visible-prose typo text-node fixes. Run the same document-quality and persona-lens checks, preserve classifications, and fall back to report-only with `fixes_applied`/`applied_fixes_count` set to `0` whenever the helper refuses. Do not run markdown `safe_auto` writes, `gated_auto`/`manual` apply-set edits, or Append-to-Open-Questions write-back that inserts markdown `##`/`###` headings.
   - Any other type: skip non-blockingly and explain that only markdown and HTML CE plan/requirements artifacts are supported.
3. Read the document enough to evaluate structure and consistency. For long documents, scan headings first, then read the Goal Capsule/Product Contract/Plan/Implementation Units/Verification/Definition of Done sections as present. For HTML, use the rendered document text/semantic headings as review input; never rewrite tags with markdown text edits, inject markdown, or mutate outside the DOM-safe helper.
4. Check for:
   - Product scope drift: requirements or Product Contract rewritten without a clear preservation note.
   - HOW gaps: implementation units lacking files, dependencies, risks, or verification scenarios.
   - Coherence gaps: contradictory decisions, stale handoff instructions, duplicated or inconsistent artifact readiness metadata.
   - Feasibility gaps: sequencing that cannot work, missing prerequisite decisions, or verification that cannot prove the stated Definition of Done.
   - Hygiene that is safe to fix automatically in the target format: markdown-only broken heading levels, duplicate blank lines, malformed checklists, or typo-level wording for markdown; for HTML, only the four DOM-safe helper operations may apply. Malformed-checklist HTML repair remains report-only until CE defines a canonical HTML checklist representation.
5. In headless mode, apply only `safe_auto` fixes directly to markdown files. Do not apply changes that alter product scope, technical decisions, acceptance criteria, or verification obligations; report those as findings. In HTML mode, call the DOM-safe helper only for allowlisted operations; on any round-trip, anchor, protected-region, visible-text, validation, unsupported-operation, or write failure, apply nothing and return the review envelope with `fixes_applied = 0` and classifications intact.
6. If findings remain, classify each as:
   - `proposed_fix`: a safe but non-trivial improvement the user may accept.
   - `decision`: a scope/technical judgment that needs human or planner choice.
   - `fyi`: useful observation that does not need routing.
7. Interactive routing:
   - Markdown: the caller may choose whether to apply proposed fixes, route decisions, or append unresolved items to Open Questions.
   - HTML: skip apply and Append-to-Open-Questions choices entirely. Present the findings as a report-only summary, recommend regenerating markdown only if the user wants in-file autofix/write-back, and leave the HTML artifact unchanged.
8. End with a concise summary and exactly one trailing JSON object on the final line.

## Output contract

Use this shape for the final line:

```json
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","fixes_applied":0,"proposed_fixes_count":0,"decisions_count":0,"fyi_count":0,"notes":"short summary"}
```

- `APPROVE`: no actionable issues remain.
- `APPROVE_WITH_NOTES`: non-blocking observations or report-only HTML findings; this is the normal result for optional workflow use.
- `REVISE`: only for severe document issues that make downstream work unsafe or impossible. In the Fusion built-in workflow this skill is advisory/non-blocking, but the verdict still helps humans see severity.

For HTML reviews, the JSON must still be emitted. When DOM-safe mutation is refused or unsupported, `fixes_applied` must be `0`, and notes should mention that HTML fell back to report-only without autofix; successful DOM-safe helper fixes may increment `fixes_applied` only for the allowlisted operations.

Do not wrap the final JSON in markdown fences.
