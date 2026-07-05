---
"@runfusion/fusion": patch
---

summary: Original task prompt now renders as Markdown and is collapsed by default in the task Plan tab.
category: feature
dev: Task Detail Plan/Definition tab original-prompt section reuses the existing `.detail-source-toggle`/`.detail-source-chevron--expanded` collapse pattern and the shared `ReactMarkdown` pipeline (`remarkGfm`, `sharedRehypePlugins`, `markdownLinkifyComponents`); backed by read-only `task.description`, no change to the generated `PROMPT.md` editor/revision flow.
