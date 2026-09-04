---
"@runfusion/fusion": patch
---

summary: Fusion tools now refuse a task write when two agent sessions share one directory and the caller is ambiguous.
category: security
dev: U18/KTD2 Stage D. Converts the 151 dashboard and 67 CLI mutating store call sites to the required `RunMutationContext`. `fn_*` extension tools resolve the caller through `resolveExtensionMutationContext`: an agent principal derives a real actor via `mutationContextForAgent`, an operator/unresolved principal takes `UNATTRIBUTED_MUTATION_CONTEXT` (U11 replaces `cliOperatorMutationContext()`), and an `ambiguous` principal fails closed with `ambiguous-caller-identity` instead of guessing. Closes two structural store-shape seams (`CliRelaunchTaskStoreLike` in `dashboard/src/server.ts`, the `updateTaskCustomFields` widening in `register-task-workflow-routes.ts`). Adds `dashboard: 150` and `cli: 2` roots to the unattributed-actor census ratchet.
