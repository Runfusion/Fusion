---
"@runfusion/fusion": patch
---

summary: Fix Grok ACP startup failure by defaulting --no-auto-update off. The released Grok CLI (v1.0.0) does not recognize `--no-auto-update` and exits immediately with "unexpected argument", causing Fusion to report "ACP connection closed." The flag is now opt-in via noAutoUpdate:true.
category: fix
dev: buildGrokAcpArgs now only pushes --no-auto-update when explicitly enabled (options.noAutoUpdate === true) instead of defaulting to true; updated acp-settings.test.ts assertions accordingly.
