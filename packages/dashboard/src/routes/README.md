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
- `registerPluginsAutomationRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerApprovalRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerWorktrunkRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerModelRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerCustomProviderRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAuthRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerRuntimeProviderRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerFnBinaryRoutes` — domain registrar mounted by `createApiRoutes`.
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
16. `registerModelRoutes`
17. `registerCustomProviderRoutes`
18. `registerAuthRoutes`
19. `registerRuntimeProviderRoutes`
20. `registerFnBinaryRoutes`
21. `registerUsageRoutes`
22. `registerCommandCenterRoutes`
23. `registerKnowledgeRoutes`
24. `registerReportRoutes`
25. `registerSignalRoutes`
26. `registerMonitorRoutes`
27. `registerUpdateCheckRoutes`
28. `registerDiagnosticsRoutes`
29. `registerCliAgentHooksRoute`
30. `registerCliAgentSettingsRoutes`
31. `registerAgentCoreListCreateRoutes`
32. `registerAgentImportExportRoutes`
33. `registerOrgPortabilityRoutes`
34. `registerAgentCoreRoutes`
35. `registerAgentRuntimeRoutes`
36. `registerSystemRoutes`
37. `registerAgentReflectionRatingRoutes`
38. `registerAgentGenerationRoutes`
39. `registerIntegratedRouters`
40. `registerProjectRoutes`
41. `registerNodeRoutes`
42. `registerDockerNodeRoutes`
43. `registerDockerProvisioningRoutes`
44. `registerSettingsSyncRoutes`
45. `registerSecretsSyncRoutes`
46. `registerMeshRoutes`
47. `registerDiscoveryRoutes`
48. `registerSettingsSyncInboundRoutes`
49. `registerSecretsSyncInboundRoutes`
50. `registerIntegratedDevServerRouter`
51. `registerAgentSkillsRoutes`
52. `registerProxyRoutes`
<!-- mount-sequence:end -->

## Ordering rules

- Specific operation paths precede parameterized and wildcard paths.
- `registerProxyRoutes` is always last; its explicit `/proxy/:nodeId/health`, project, task, project-health, and event paths precede `ALL /proxy/:nodeId/{*splat}` inside the registrar.
- Keep model → auth → usage, the agent core/list → core → runtime chain, and project → node → sync → mesh → discovery → inbound-sync ordering unchanged unless a tested precedence migration requires it.
- Keep integrated routers before project/node routes and the integrated dev-server router before skills and proxy routes.
- Preserve the file aggregator's session-diff → file-workspace → terminal nesting and its operation-before-wildcard rules.

## Guardrails and verification

Residual inline handlers in `routes.ts` are grandfathered only. `pnpm check:routes-modular` compares their executable registration count to `scripts/lib/routes-modular-baseline.json`; the count may decrease but cannot grow. It runs in local `pretest`/`pretest:full` and blocking PR checks.

`src/routes/__tests__/create-api-routes-mount-order.test.ts` locks sequence pairs, exercises the live runtime mounter, verifies proxy path precedence, and checks this README. Route extractions must run both dashboard typechecking and targeted route tests:

```bash
pnpm --filter @fusion/dashboard typecheck
pnpm --filter @fusion/dashboard exec vitest run src/routes/__tests__/create-api-routes-mount-order.test.ts --silent=passed-only --reporter=dot
```
