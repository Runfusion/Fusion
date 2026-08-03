---
"@runfusion/fusion": patch
---

summary: Self-heal executor credential resolution so custom providers and renames match chat.
category: fix
dev: Stop synthesizing credentialInstanceId "default" into executor sessions; soft-fail unresolved instances to the legacy unscoped auth path (customProviders.apiKey); collapse-match renamed custom-provider auth slugs when unique.
