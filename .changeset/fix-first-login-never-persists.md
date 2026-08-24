---
"@runfusion/fusion": patch
---

summary: Fix a provider's first-ever login silently failing with "Login did not complete" on a fresh install.
category: fix
dev: `FusionAuthStorage.modify()` resolved its write target with `creating: false` and returned before invoking the callback whenever the provider had no credential row yet. That is the seam pi persists a completed login through (`Models.login` -> `credentials.modify(provider.id, ...)`), so a first login finished its OAuth, exchanged the code, took and released the lock file, wrote nothing, and resolved as success — leaving the dashboard poll to report the generic failure. Only reproduces on a store with no existing row, so long-lived installs (where the path is a refresh) were unaffected while every new container/machine/wiped `~/.fusion` could never complete a first login for any provider. Also surfaces the server's own `loginError` through `describeLoginFailure` instead of the generic sentence, so an `OAuth state mismatch` reads as a stale-tab instruction.
