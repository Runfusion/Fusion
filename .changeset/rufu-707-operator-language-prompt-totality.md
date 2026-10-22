---
"@runfusion/fusion": patch
---

summary: Workflow steps no longer crash when the operator language is unset or Automatic.
category: fix
dev: Prompt-section composition now drops nullish sections with an optional-chaining predicate at all six join sites; buildOperatorLanguageDirective still returns string | undefined and the "auto" default is unchanged.
