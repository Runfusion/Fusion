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
- `registerJiraRoutes` — read-only JIRA branch-name derivation endpoint.
- `registerFilesTerminalWorkspaceRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerAgentsProjectsNodesRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerPluginsAutomationRoutes` — automation and routine CRUD/manual-run/webhook endpoints plus live SSE streams, and plugin-management endpoints. It preserves the `/plugins/:id` registry pass-through; `createPluginRouter` remains mounted later by `routes.ts` so `/plugins/registry` retains precedence. Its co-located `automation-live-run.ts`, `automation-step-execution.ts`, and `plugin-bundled-runtimes.ts` helpers own replayable output, execution, and bundled-runtime fallback metadata.
- `registerApprovalRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerWorktrunkRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerConfigMcpPiSettingsRoutes` (`register-config-mcp-pi-settings-routes.ts`) — config/MCP/Pi-settings registrar with 7 endpoint registrations: `GET /config`; `GET /mcp/discovered`; `POST /mcp/validate`; `GET /pi-settings`; `PUT /pi-settings`; `POST /pi-settings/packages`; `POST /pi-settings/reinstall-fusion`.
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
- `registerVoiceRoutes` — opt-in voice model lifecycle and project-bound PCM transcription endpoints.
- `registerDiagnosticsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerCliAgentHooksRoute` — domain registrar mounted by `createApiRoutes`.
- `registerCliAgentSettingsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerActivityLogRoutes` — the early activity-log GET/DELETE split export plus `GET /api/agent-activity` seq-cursor history from `register-setup-activity-routes.ts`.
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
- `registerUiMetadataRoutes` — static, project-independent dashboard view and settings-section discovery endpoints.
- `registerSettingsSyncInboundRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSecretsSyncInboundRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerSetupActivityRoutes` — the late activity feed, concurrency, and setup split export from `register-setup-activity-routes.ts`.
- `registerIntegratedDevServerRouter` — domain registrar mounted by `createApiRoutes`.
- `registerAgentSkillsRoutes` — domain registrar mounted by `createApiRoutes`.
- `registerPatchnodeRoutes` — project-scoped read-only History delivery feed.
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
11. `registerJiraRoutes`
12. `registerFilesTerminalWorkspaceRoutes`
13. `registerAgentsProjectsNodesRoutes`
14. `registerPluginsAutomationRoutes`
15. `registerApprovalRoutes`
16. `registerWorktrunkRoutes`
17. `registerConfigMcpPiSettingsRoutes`
18. `registerSystemMaintenanceRoutes`
19. `registerModelRoutes`
20. `registerCustomProviderRoutes`
21. `registerAuthRoutes`
22. `registerRuntimeProviderRoutes`
23. `registerFnBinaryRoutes`
24. `registerAiTextAssistantRoutes`
25. `registerUsageRoutes`
26. `registerCommandCenterRoutes`
27. `registerKnowledgeRoutes`
28. `registerReportRoutes`
29. `registerSignalRoutes`
30. `registerMonitorRoutes`
31. `registerUpdateCheckRoutes`
32. `registerVoiceRoutes`
33. `registerDiagnosticsRoutes`
34. `registerCliAgentHooksRoute`
35. `registerCliAgentSettingsRoutes`
36. `registerActivityLogRoutes`
37. `registerAgentCoreListCreateRoutes`
38. `registerAgentImportExportRoutes`
39. `registerOrgPortabilityRoutes`
40. `registerAgentCoreRoutes`
41. `registerAgentRuntimeRoutes`
42. `registerSystemRoutes`
43. `registerAgentReflectionRatingRoutes`
44. `registerAgentGenerationRoutes`
45. `registerIntegratedRouters`
46. `registerProjectRoutes`
47. `registerNodeRoutes`
48. `registerDockerNodeRoutes`
49. `registerDockerProvisioningRoutes`
50. `registerSettingsSyncRoutes`
51. `registerSecretsSyncRoutes`
52. `registerMeshRoutes`
53. `registerDiscoveryRoutes`
54. `registerUiMetadataRoutes`
55. `registerSettingsSyncInboundRoutes`
56. `registerSecretsSyncInboundRoutes`
57. `registerSetupActivityRoutes`
58. `registerIntegratedDevServerRouter`
59. `registerAgentSkillsRoutes`
60. `registerPatchnodeRoutes`
61. `registerProxyRoutes`
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

## Voice transcription

`registerVoiceRoutes` exposes `GET /voice/status`, `POST`/`DELETE /voice/model`,
`POST /voice/runtime/recheck`, and dictation `POST /voice/session`, `POST /voice/transcribe`, and
`DELETE /voice/session/:id`. Re-check clears the memoized runtime attempt and returns the same
model/runtime status shape as `GET /voice/status`; it does not close active sessions. Settings are
resolved per request through `getScopedStore(req)` with project-over-global precedence. Voice is
opt-in: only dictation endpoints require `voiceInput.enabled`; model inspection, download, delete,
and runtime re-check remain available while off because the user-scoped model cache is shared by
projects.

Audio chunks are base64 raw 16 kHz mono signed-16-bit little-endian PCM. Chunks are ordered,
limited to 1 MiB (2 MiB JSON body), and sessions are project-bound. Active sessions become
60-second closed tombstones on completion, delete, expiry, model removal, or the 16 MiB cap; cap
tombstones return 413 while other closed sessions return 409, then all evict to 404. Repeated
DELETE during the tombstone returns `{ closed:true, alreadyClosed:true }`; unknown and foreign IDs
return 404. Download returns 202 with queued/downloading state; poll status for progress.

`server.ts` excludes only `/api/voice/transcribe` from its global 100 KiB JSON parser so the
route's 2 MiB parser can return JSON 413/400 errors; other routes retain raw-body HMAC capture.

## Large text JSON parsing

`server.ts` preserves raw bodies and selects a finite parser before metrics, authentication, and
all API registrars. The default remains 100 KiB. Only `POST /api/chat/sessions/:id/messages` and
`POST /api/chat/rooms/:id/messages` (including optional trailing slashes) receive a 2 MiB JSON
limit. Multipart requests on those paths are not parsed by `express.json()` and continue to Multer.

Only non-empty `POST /api/tasks/:id/files/{*filepath}` and generic
`POST /api/files/{*filepath}` saves receive `6 * MAX_FILE_SIZE + 1024` bytes (6,292,480 bytes).
A supported 1 MiB UTF-8 string can expand to six bytes per control character in canonical JSON;
the extra 1 KiB covers object framing. `/api/files/mkdir` and literal terminal `/copy`, `/move`,
`/delete`, and `/rename` operation paths retain 100 KiB, including optional trailing slashes. The
selector uses query-free, undecoded `req.path`, so an encoded filepath such as `src%2Fcopy` remains
a generic save rather than an operation.

The roughly 6 MiB file envelope is a deliberate exact-route trade-off: Express warns that larger
bodies consume memory and can add latency. It is not derived from model context windows, because
HTTP parsing precedes model selection, bytes are not tokens, and model context also includes
history, system/tool input, reasoning, and output. GitHub raw webhook parsing stays first;
Voice keeps its route-owned 2 MiB parser and Planning keeps its route-owned 5 MiB parser.
