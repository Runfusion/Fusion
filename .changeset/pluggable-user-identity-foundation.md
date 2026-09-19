---
"@runfusion/fusion": minor
---

summary: Plugins can no longer grant themselves roles or call ungated TaskStore writes.
category: security
dev: Migration 0059 adds the actor/credential/session/role-grant schema and REVOKEs write on `project.actor_role_grants` from `fusion_runtime` — the role a plugin's `getAsyncLayer()` handle connects as — closing a path where any installed plugin could insert itself an `admin` grant (RLS filters by `project_id`, never by caller). Grant writes moved to a new owner-connection handle (`AsyncDataLayer.privilegedDb`); `revokeActorRole` gained an explicit `project_id` scope because that connection bypasses RLS. `createPluginGatedTaskStore` is now deny-by-default on the write surface: reads pass by verb prefix, writes require an allowlist entry, destructive writes still require `permissions.destructiveTaskOps`, and that declaration no longer returns the raw ungated store. Breaking for third-party plugins performing writes outside the allowlist; the thrown error names the method. New `identityEnabled` global-only setting (default false) gates all enforcement.
