---
"@runfusion/fusion": patch
---

summary: Keep OAuth re-login status consistent after automatic token renewal.
category: fix
dev: Routes non-Anthropic OAuth refreshes through pi ModelRuntime and promptly revalidates the dashboard banner.
