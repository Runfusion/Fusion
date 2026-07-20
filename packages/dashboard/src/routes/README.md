# Dashboard API route registrars

`packages/dashboard/src/routes.ts` exports `createApiRoutes(store, options)`. It is an orchestrator: it creates shared context and mounts domain registrars. New endpoints belong in the appropriate module in this directory; do **not** add inline `router.get`, `router.post`, or other `router.*` registrations to `routes.ts`.

## Shared context

Registrars receive `ApiRoutesContext`, built by `createApiRoutesContext()` in `context.ts`, and should use the `ApiRouteRegistrar` contract in `types.ts`. The context supplies project scoping, logging, diagnostics, error normalization, and scoped automation/routine helpers without duplicating server plumbing.

## Registrar module map

The following is the complete top-level registrar map currently imported by `routes.ts`. Most names map directly to `register-*.ts`; `registerMonitorRoutes` is in `monitor-routes.ts`, CLI agent hooks/settings are in `cli-agent-hooks.ts` and `cli-agent-settings.ts`, and integrated routers are in `register-integrated-routers.ts`.

- `registerSettingsMemoryRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSecretsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerTaskWorkflowRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerWorkflowRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerPlanningSubtaskRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerChatRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerChatRoomRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerMessagingScriptRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerGitGitHubRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerGitLabRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerFilesTerminalWorkspaceRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentsProjectsNodesRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerPluginsAutomationRoutes` — automation and routine CRUD/manual-run/webhook endpoints plus live SSE streams, and plugin-management endpoints. It preserves the `/plugins/:id` registry pass-through; `createPluginRouter` remains mounted later by `routes.ts` so `/plugins/registry` retains precedence. Its co-located `automation-live-run.ts`, `automation-step-execution.ts`, and `plugin-bundled-runtimes.ts` helpers own replayable output, execution, and bundled-runtime fallback metadata.
- `registerApprovalRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerWorktrunkRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSystemMaintenanceRoutes` — early-mounted system stats, vitest, maintenance-stamp, and backup routes; distinct from the late `/system/*` Command Center panel registrar.
- `registerModelRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerCustomProviderRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAuthRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerRuntimeProviderRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerFnBinaryRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAiTextAssistantRoutes` — AI refine, translate, goal-draft, and title-summary endpoints.
- `registerUsageRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerCommandCenterRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerKnowledgeRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerReportRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSignalRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerMonitorRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerUpdateCheckRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerDiagnosticsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerCliAgentHooksRoute` — domain registrar mounted by `createApiRoutes`.
- `registerCliAgentSettingsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerActivityLogRoutes` — the early activity-log GET/DELETE split export from `register-setup-activity-routes.ts`.
- `registerAgentCoreListCreateRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentImportExportRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerOrgPortabilityRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentCoreRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentRuntimeRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSystemRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentReflectionRatingRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentGenerationRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerIntegratedRouters` — domain registrar mounted by `createApiRoutes`.
- `registerProjectRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerNodeRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerDockerNodeRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerDockerProvisioningRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSettingsSyncRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSecretsSyncRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerMeshRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerDiscoveryRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSettingsSyncInboundRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSecretsSyncInboundRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSetupActivityRoutes` — the late activity feed, concurrency, and setup split export from `register-setup-activity-routes.ts`.
- `registerIntegratedDevServerRouter` — domain registrar mounted by `createApiRoutes`.
- `registerAgentSkillsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerProxyRoutes` — domain registrar mounted by `createApiRoutes`.

`registerFilesTerminalWorkspaceRoutes` is an infrastructure aggregator: it preserves nested `session-diff → file-workspace → terminal` registration order. Its file operation routes stay before generic file wildcards. `registerIntegratedRouters` mounts the missions, ideation, insights, evals, research, experiments, todos, goals, roadmaps, stash-recovery, and branch-group integrated routers; `registerIntegratedDevServerRouter` mounts `/dev-server`.

## Mount sequence (machine-readable)

Express matches in registration order. `create-api-routes-mount-sequence.ts` is the runtime source of truth: its mounter rejects missing, duplicate, or out-of-order top-level mounts during router construction. The test parses the markers and numbered, backtick-wrapped list below; update this list and the exported sequence in the same change.

<!-- mount-sequence:start -->
1. `registerSettingsMemoryRoutes`
2. `registerSecretsRoutes`
3. `registerTaskWorkflowRoutes`
4. `registerWorkflowRoutes`
5. `registerPlanningSubtaskRoutes`
6. `registerChatRoutes`
7. `registerChatRoomRoutes`
8. `registerMessagingScriptRoutes`
9. `registerGitGitHubRoutes`
10. `registerGitLabRoutes`
11. `registerFilesTerminalWorkspaceRoutes`
12. `registerAgentsProjectsNodesRoutes`
13. `registerPluginsAutomationRoutes`
14. `registerApprovalRoutes`
15. `registerWorktrunkRoutes`
16. `registerSystemMaintenanceRoutes`
17. `registerModelRoutes`
18. `registerCustomProviderRoutes`
19. `registerAuthRoutes`
20. `registerRuntimeProviderRoutes`
21. `registerFnBinaryRoutes`
22. `registerAiTextAssistantRoutes`
23. `registerUsageRoutes`
24. `registerCommandCenterRoutes`
25. `registerKnowledgeRoutes`
26. `registerReportRoutes`
27. `registerSignalRoutes`
28. `registerMonitorRoutes`
29. `registerUpdateCheckRoutes`
30. `registerDiagnosticsRoutes`
31. `registerCliAgentHooksRoute`
32. `registerCliAgentSettingsRoutes`
33. `registerActivityLogRoutes`
34. `registerAgentCoreListCreateRoutes`
35. `registerAgentImportExportRoutes`
36. `registerOrgPortabilityRoutes`
37. `registerAgentCoreRoutes`
38. `registerAgentRuntimeRoutes`
39. `registerSystemRoutes`
40. `registerAgentReflectionRatingRoutes`
41. `registerAgentGenerationRoutes`
42. `registerIntegratedRouters`
43. `registerProjectRoutes`
44. `registerNodeRoutes`
45. `registerDockerNodeRoutes`
46. `registerDockerProvisioningRoutes`
47. `registerSettingsSyncRoutes`
48. `registerSecretsSyncRoutes`
49. `registerMeshRoutes`
50. `registerDiscoveryRoutes`
51. `registerSettingsSyncInboundRoutes`
52. `registerSecretsSyncInboundRoutes`
53. `registerSetupActivityRoutes`
54. `registerIntegratedDevServerRouter`
55. `registerAgentSkillsRoutes`
56. `registerProxyRoutes`
<!-- mount-sequence:end -->

## Ordering rules

- Specific operation paths precede parameterized and wildcard paths.
- `registerProxyRoutes` is always last; its explicit `/proxy/:nodeId/health`, project, task, project-health, and event paths precede `ALL /proxy/:nodeId/{*splat}` inside the registrar.
- Keep model → auth → usage, the agent core/list → core → runtime chain, and project → node → sync → mesh → discovery → inbound-sync ordering unchanged unless a tested precedence migration requires it.
- Keep integrated routers before project/node routes and the integrated dev-server router before skills and proxy routes.
- Keep plugin management registration ahead of the later `createPluginRouter` mount. Its `/plugins/:id` handler calls `next()` for `registry`, allowing the sub-router's registry route to serve that static path.
- Preserve the file aggregator's session-diff → file-workspace → terminal nesting and its operation-before-wildcard rules.

## Guardrails and verification

Residual inline handlers in `routes.ts` are grandfathered only. `pnpm check:routes-modular` compares their executable registration count to `scripts/lib/routes-modular-baseline.json`; the count may decrease but cannot grow. It runs in local `pretest`/`pretest:full` and blocking PR checks.

`src/routes/__tests__/create-api-routes-mount-order.test.ts` locks sequence pairs, exercises the live runtime mounter, verifies proxy path precedence, and checks this README. Route extractions must run both dashboard typechecking and targeted route tests:

```bash
pnpm --filter @fusion/dashboard typecheck
pnpm --filter @fusion/dashboard exec vitest run src/routes/__tests__/create-api-routes-mount-order.test.ts --silent=passed-only --reporter=dot
```
