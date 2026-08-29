// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import {
  CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE,
  createRegistrarMounter,
} from "../create-api-routes-mount-sequence.js";

function indexOf(id: (typeof CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE)[number]) {
  return CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE.indexOf(id);
}

function createMockStore(): TaskStore {
  return { getRootDir: vi.fn(() => process.cwd()) } as unknown as TaskStore;
}

function documentedMountIds(readme: string) {
  const section = readme.match(/<!-- mount-sequence:start -->([\s\S]*?)<!-- mount-sequence:end -->/);
  expect(section, "Update routes/README.md and the mount sequence together.").not.toBeNull();
  return [...section![1].matchAll(/^\d+\. `([^`]+)`$/gm)].map((match) => match[1]);
}

describe("createApiRoutes registrar mount order", () => {
  it("pins precedence-sensitive registrar pairs and historically omitted registrars", () => {
    expect(CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE.at(-1)).toBe("registerProxyRoutes");
    expect(indexOf("registerFilesTerminalWorkspaceRoutes")).toBeLessThan(indexOf("registerProxyRoutes"));
    expect(indexOf("registerModelRoutes")).toBeLessThan(indexOf("registerAuthRoutes"));
    expect(indexOf("registerAuthRoutes")).toBeLessThan(indexOf("registerUsageRoutes"));
    expect(indexOf("registerAgentCoreListCreateRoutes")).toBeLessThan(indexOf("registerAgentCoreRoutes"));
    expect(indexOf("registerAgentCoreRoutes")).toBeLessThan(indexOf("registerAgentRuntimeRoutes"));
    for (const [earlier, later] of [["registerProjectRoutes", "registerNodeRoutes"], ["registerNodeRoutes", "registerSettingsSyncRoutes"], ["registerSettingsSyncRoutes", "registerMeshRoutes"], ["registerMeshRoutes", "registerDiscoveryRoutes"], ["registerDiscoveryRoutes", "registerSettingsSyncInboundRoutes"], ["registerAgentSkillsRoutes", "registerProxyRoutes"], ["registerIntegratedRouters", "registerProjectRoutes"], ["registerIntegratedDevServerRouter", "registerAgentSkillsRoutes"]] as const) {
      expect(indexOf(earlier)).toBeLessThan(indexOf(later));
    }
    for (const id of ["registerCliAgentHooksRoute", "registerPluginsAutomationRoutes", "registerSecretsRoutes", "registerWorkflowRoutes", "registerChatRoomRoutes", "registerGitLabRoutes", "registerApprovalRoutes", "registerWorktrunkRoutes"] as const) {
      expect(CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE).toContain(id);
    }
  });

  it("uses the exported sequence as a live runtime gate", () => {
    const mounter = createRegistrarMounter();
    expect(() => mounter.mount("registerProxyRoutes", () => undefined)).toThrow(/expected registerSettingsMemoryRoutes/);
    for (const id of CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE) mounter.mount(id, () => undefined);
    mounter.assertComplete();
    expect(mounter.mountedIds()).toEqual(CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE);

    expect(() => createApiRoutes(createMockStore())).not.toThrow();
  });

  it("keeps explicit proxy paths ahead of the proxy wildcard in the production router", () => {
    const router: Router = createApiRoutes(createMockStore());
    const paths = ((router as unknown as { stack: Array<{ route?: { path?: string } }> }).stack)
      .map((layer) => layer.route?.path)
      .filter((path): path is string => Boolean(path));
    expect(paths.indexOf("/proxy/:nodeId/health")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/proxy/:nodeId/{*splat}")).toBeGreaterThan(paths.indexOf("/proxy/:nodeId/health"));
  });

  it("keeps the machine-readable README sequence synchronized", () => {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
    expect(documentedMountIds(readFileSync(readmePath, "utf8"))).toEqual(CREATE_API_ROUTES_REGISTRAR_MOUNT_SEQUENCE);
  });
});
