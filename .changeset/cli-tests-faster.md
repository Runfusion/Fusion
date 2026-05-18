---
"@runfusion/fusion": patch
---

Make CLI test suite ~3× faster: add a `replyTimeoutMs` option to `runChatInteractive` so the `--once` timeout test no longer waits a real 30s for "No reply within 30s", and gate the heavyweight esbuild-bundled-plugin integration test behind `FUSION_RUN_SLOW_TESTS=1` (the same install/upgrade logic is covered by mocked unit tests in the same file).
