---
"@runfusion/fusion": patch
---
summary: Desktop builds now typecheck streamed speech-model downloads across differing ReadableStream library definitions.
category: fix
dev: Casts the fetch response body through unknown before treating it as an async byte iterable, preserving runtime behavior while satisfying the desktop TypeScript library surface.
