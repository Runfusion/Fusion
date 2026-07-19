/*
FNXC:RouteModularity 2026-07-19-12:00:
New dashboard API endpoints belong in domain registrars. createApiRoutes remains an
orchestrator, and this runtime-enforced sequence preserves Express first-match
precedence while residual inline routes are reduced by a separate ratchet.
*/

export const CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE = [
  "registerSettingsMemoryRoutes", "registerSecretsRoutes", "registerTaskWorkflowRoutes", "registerWorkflowRoutes",
  "registerPlanningSubtaskRoutes", "registerChatRoutes", "registerChatRoomRoutes", "registerMessagingScriptRoutes",
  "registerGitGitHubRoutes", "registerGitLabRoutes", "registerFilesTerminalWorkspaceRoutes", "registerAgentsProjectsNodesRoutes",
  "registerPluginsAutomationRoutes", "registerApprovalRoutes", "registerWorktrunkRoutes", "registerModelRoutes",
  "registerCustomProviderRoutes", "registerAuthRoutes", "registerRuntimeProviderRoutes", "registerFnBinaryRoutes",
  "registerUsageRoutes", "registerCommandCenterRoutes", "registerKnowledgeRoutes", "registerReportRoutes",
  "registerSignalRoutes", "registerMonitorRoutes", "registerUpdateCheckRoutes", "registerDiagnosticsRoutes",
  "registerCliAgentHooksRoute", "registerCliAgentSettingsRoutes", "registerAgentCoreListCreateRoutes", "registerAgentImportExportRoutes",
  "registerOrgPortabilityRoutes", "registerAgentCoreRoutes", "registerAgentRuntimeRoutes", "registerSystemRoutes",
  "registerAgentReflectionRatingRoutes", "registerAgentGenerationRoutes", "registerIntegratedRouters", "registerProjectRoutes",
  "registerNodeRoutes", "registerDockerNodeRoutes", "registerDockerProvisioningRoutes", "registerSettingsSyncRoutes",
  "registerSecretsSyncRoutes", "registerMeshRoutes", "registerDiscoveryRoutes", "registerSettingsSyncInboundRoutes",
  "registerSecretsSyncInboundRoutes", "registerIntegratedDevServerRouter", "registerAgentSkillsRoutes", "registerProxyRoutes",
] as const;

export type CreateApiRoutesRegistrarId = (typeof CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE)[number];

export interface RegistrarMounter {
  mount(id: CreateApiRoutesRegistrarId, register: () => void): void;
  assertComplete(): void;
  mountedIds(): readonly CreateApiRoutesRegistrarId[];
}

/** Runtime gate: a missing, duplicate, or reordered top-level registrar fails boot. */
export function createRegistrarMounter(): RegistrarMounter {
  const mounted: CreateApiRoutesRegistrarId[] = [];
  let nextIndex = 0;

  return {
    mount(id, register) {
      const expected = CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE[nextIndex];
      if (id !== expected) {
        throw new Error(`createApiRoutes registrar mount order violation: expected ${expected ?? "no further registrar"}, received ${id}`);
      }
      register();
      mounted.push(id);
      nextIndex += 1;
    },
    assertComplete() {
      if (nextIndex !== CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE.length) {
        throw new Error(`createApiRoutes registrar mount sequence incomplete: mounted ${nextIndex} of ${CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE.length}; next is ${CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE[nextIndex]}`);
      }
    },
    mountedIds: () => mounted,
  };
}
