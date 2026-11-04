---
"@runfusion/fusion": patch
---

summary: Workflow step sessions no longer fail on projects left on the default "Automatic" operator language.
category: fix
dev: The step-prompt composition put the optional operator-language directive (absent for unset/"auto", the schema default) into a `.filter((section) => section.trim())` join, so building the prompt threw `Cannot read properties of undefined (reading 'trim')` and the step died before its session ran. The join now tolerates the absence the way every other lane already does (`prompt-layers.ts` uses `?.trim()`); pinned by a default-language executor-lane case in `executor-step-text-fidelity.test.ts`.
