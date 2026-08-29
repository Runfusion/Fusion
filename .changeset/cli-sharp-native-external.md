---
"@runfusion/fusion": patch
---

summary: Keep sharp native binaries out of the CLI plugin bundle so packaging succeeds on 0.35.
category: fix
dev: Externalize `sharp` and `@img/sharp-*` in tsup/esbuild; sharp 0.35 ships platform `.node` addons that esbuild cannot load.
