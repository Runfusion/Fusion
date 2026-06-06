---
"@runfusion/fusion": patch
---

Move Fusion Pro releases to private package and artifact destinations by default.

The local release script now validates a private package target before release side effects, publishes the CLI package to the configured private registry, skips public Homebrew/public release side effects, and leaves binary builds in private workflow artifacts.

Also restores non-interactive `fn project add` argument validation so missing required arguments fail before any project registry work starts.
