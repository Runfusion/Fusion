---
"@runfusion/fusion": minor
---

summary: Add a simplified workflow editor view with a modern vertical canvas, plus Simple/Advanced/List mode toggle.
category: feature
dev: New WorkflowSimpleCanvas + WorkflowAddStepModal components; view mode persists in localStorage (`fusion:wf-editor-view-mode`, mobile `fusion:wf-mobile-graph-style`); insert-on-edge helpers live in workflow-simple-layout.ts. The old "Show simple editor" compact layout is now the List mode; the advanced canvas is unchanged.
