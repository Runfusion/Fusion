---
"@runfusion/fusion": patch
---

summary: Hermes Runtime is now additive — connecting it no longer hides your custom providers, models, or auth options.
category: fix
dev: Audited the Hermes Runtime plugin (onLoad/onUnload, CLI-spawn/probe seams) and register-model-routes.ts/register-auth-routes.ts against GitHub #1931. Confirmed the reported customProviders suppression was already fixed generically (unrelated to Hermes) and that Hermes's PluginContext has no reference to AuthStorage/ModelRegistry, so it cannot mutate either store. Added FNXC documentation comments locking in the additive-runtime invariant and regression coverage across the model-picker (/api/models), custom-provider CRUD, and auth-status surfaces proving a connected Hermes runtime never narrows them. Item 3 (static auth catalog) remains owned by FN-7625; item 1 (additive Hermes-model surfacing in the picker) is deferred to a follow-up task (FN-7636) pending a non-blocking CLI-spawn caching strategy.
