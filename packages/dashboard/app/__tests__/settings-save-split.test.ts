/**
 * Characterization of SettingsModal's save-split (U9 / KTD-10).
 *
 * Pins the regression-critical behavior the redesign must preserve byte-for-byte:
 *   - one global + one project edit in a single session produce the expected
 *     `updateGlobalSettings` / `updateSettings` patches with strict scope routing;
 *   - clearing a project override emits null-as-delete;
 *   - untouched global values are NOT written (changed-only gate);
 *   - untouched inherited project values are NOT written (changed-only gate);
 *   - explicit clears of global keys emit null, plain undefined is dropped.
 *
 * The split logic was lifted out of the modal into the pure `splitSettingsSave`
 * helper; this test exercises it against the real `@fusion/core` key predicates
 * so it stays honest about which keys land in which scope.
 */
import { describe, it, expect } from "vitest";
import { isGlobalSettingsKey, isProjectSettingsKey } from "@fusion/core";
import { splitSettingsSave, MODEL_LANE_KEYS } from "../components/settings/save-split";

// Sanity-anchor the scope of the concrete keys this test relies on, so the
// assertions below remain meaningful if core's catalog ever shifts.
describe("scope anchors", () => {
  it("language and ntfyTopic are global; maxConcurrent and integrationBranch are project", () => {
    expect(isGlobalSettingsKey("language")).toBe(true);
    expect(isGlobalSettingsKey("ntfyTopic")).toBe(true);
    expect(isProjectSettingsKey("maxConcurrent")).toBe(true);
    expect(isProjectSettingsKey("integrationBranch")).toBe(true);
    expect(isProjectSettingsKey("enabledBuiltinWorkflowIds")).toBe(true);
    expect(isProjectSettingsKey("githubLinkImportedIssuesToTracking")).toBe(true);
    expect(isGlobalSettingsKey("githubLinkImportedIssuesToTracking")).toBe(false);
    expect(isGlobalSettingsKey("gitlabEnabled")).toBe(true);
    expect(isProjectSettingsKey("gitlabEnabled")).toBe(true);
    expect(isGlobalSettingsKey("gitlabAuthToken")).toBe(true);
    expect(isProjectSettingsKey("gitlabAuthToken")).toBe(true);
    expect(isGlobalSettingsKey("gitlabAuthTokenType")).toBe(true);
    expect(isProjectSettingsKey("gitlabAuthTokenType")).toBe(true);
  });

  it("every MODEL_LANE_KEYS entry is a project settings key", () => {
    // MODEL_LANE_KEYS only gates project-branch behavior, which is reached only
    // for keys that pass isProjectSettingsKey. Any entry that fails this check is
    // dead (e.g. a per-phase model lane that moved to workflow settings).
    expect(MODEL_LANE_KEYS.length).toBeGreaterThan(0);
    for (const key of MODEL_LANE_KEYS) {
      expect(isProjectSettingsKey(key)).toBe(true);
    }
  });
});

describe("splitSettingsSave", () => {
  it("routes one global + one project edit into the right patches", () => {
    const initialValues = { language: "en", maxConcurrent: 2 } as never;
    const initialScopedValues = {
      global: { language: "en" },
      project: { maxConcurrent: 2 },
    } as never;

    const payload: Record<string, unknown> = {
      language: "fr", // global edit
      maxConcurrent: 5, // project edit
    };

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues,
      activeSection: "global-general",
    });

    expect(globalPatch).toEqual({ language: "fr" });
    expect(projectPatch).toEqual({ maxConcurrent: 5 });
  });

  it("does not write global values that match the initial global-scoped value", () => {
    const initialScopedValues = {
      global: {
        ntfyEnabled: true,
        ntfyTopic: "alerts",
        ntfyEvents: ["failed", "merged"],
        notificationProviders: [{ id: "ntfy-main", type: "ntfy", enabled: true }],
        experimentalFeatures: { insights: true },
      },
      project: {},
    } as never;

    const payload: Record<string, unknown> = {
      ntfyEnabled: true,
      ntfyTopic: "alerts",
      ntfyEvents: ["failed", "merged"],
      notificationProviders: [{ id: "ntfy-main", type: "ntfy", enabled: true }],
      experimentalFeatures: { insights: true },
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues: {
        ntfyEnabled: true,
        ntfyTopic: "alerts",
        ntfyEvents: ["failed", "merged"],
        notificationProviders: [{ id: "ntfy-main", type: "ntfy", enabled: true }],
        experimentalFeatures: { insights: true },
      } as never,
      initialScopedValues,
      activeSection: "notifications",
    });

    expect(globalPatch).toEqual({});
  });

  it("writes only the changed global value and does not carry unrelated defaults", () => {
    const initialValues = {
      colorTheme: "ocean",
      ntfyEnabled: true,
      ntfyTopic: "alerts",
      modelOnboardingComplete: true,
      experimentalFeatures: { insights: true },
    } as never;
    const initialScopedValues = {
      global: {
        colorTheme: "ocean",
        ntfyEnabled: true,
        ntfyTopic: "alerts",
        modelOnboardingComplete: true,
        experimentalFeatures: { insights: true },
      },
      project: {},
    } as never;

    const payload: Record<string, unknown> = {
      colorTheme: "shadcn-gray-blue",
      ntfyEnabled: false,
      ntfyTopic: undefined,
      modelOnboardingComplete: undefined,
      experimentalFeatures: { insights: true },
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues,
      activeSection: "appearance",
    });

    expect(globalPatch).toEqual({ colorTheme: "shadcn-gray-blue" });
  });

  it("does not carry notification defaults when saving experimental features", () => {
    const initialValues = {
      experimentalFeatures: { researchView: true },
      ntfyEnabled: true,
      ntfyTopic: "alerts",
      modelOnboardingComplete: true,
    } as never;
    const initialScopedValues = {
      global: {
        experimentalFeatures: { researchView: true },
        ntfyEnabled: true,
        ntfyTopic: "alerts",
        modelOnboardingComplete: true,
      },
      project: {},
    } as never;

    const payload: Record<string, unknown> = {
      experimentalFeatures: { researchView: true, evalsView: true },
      ntfyEnabled: false,
      ntfyTopic: undefined,
      modelOnboardingComplete: undefined,
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues,
      activeSection: "experimental",
    });

    expect(globalPatch).toEqual({ experimentalFeatures: { researchView: true, evalsView: true } });
  });

  it("does not write project values that match the initial project-scoped value (changed-only gate)", () => {
    // The gate compares the payload value against the initial *project-scoped*
    // value: a value equal to its initial override is not re-written. This is
    // what prevents every save from re-persisting unchanged overrides.
    const initialScopedValues = {
      global: {},
      project: { maxConcurrent: 3, integrationBranch: "main" },
    } as never;

    const payload: Record<string, unknown> = {
      maxConcurrent: 3, // unchanged override → skip
      integrationBranch: "main", // unchanged override → skip
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({});
  });

  it("writes a project value that differs from the initial project-scoped value", () => {
    const initialScopedValues = {
      global: {},
      project: { maxConcurrent: 3 },
    } as never;

    const payload: Record<string, unknown> = {
      maxConcurrent: 7, // changed from the initial override
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ maxConcurrent: 7 });
  });

  it("routes GitLab enable and token settings to global settings only from global general", () => {
    const initialScopedValues = {
      global: { gitlabEnabled: true, gitlabAuthToken: undefined, gitlabAuthTokenType: undefined },
      project: { gitlabEnabled: true, gitlabAuthToken: "project-token", gitlabAuthTokenType: "project" },
    } as never;

    const payload: Record<string, unknown> = {
      gitlabEnabled: false,
      gitlabAuthToken: "global-token",
      gitlabAuthTokenType: "group",
    };

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "global-general",
    });

    expect(globalPatch).toEqual({ gitlabEnabled: false, gitlabAuthToken: "global-token", gitlabAuthTokenType: "group" });
    expect(projectPatch).toEqual({});
  });

  it("routes GitLab enable and token settings to project settings outside global general", () => {
    const initialScopedValues = {
      global: { gitlabEnabled: false, gitlabAuthToken: "global-token", gitlabAuthTokenType: "group" },
      project: { gitlabEnabled: true },
    } as never;

    const payload: Record<string, unknown> = {
      gitlabEnabled: false,
      gitlabAuthToken: "project-token",
      gitlabAuthTokenType: "project",
    };

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "merge",
    });

    expect(globalPatch).toEqual({});
    expect(projectPatch).toEqual({ gitlabEnabled: false, gitlabAuthToken: "project-token", gitlabAuthTokenType: "project" });
  });

  it("clears a project GitLab token with null-as-delete while preserving selected token type", () => {
    const initialScopedValues = {
      global: {},
      project: { gitlabAuthToken: "old-project-token", gitlabAuthTokenType: "group" },
    } as never;

    const payload: Record<string, unknown> = {
      gitlabAuthToken: undefined,
      gitlabAuthTokenType: "personal",
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "merge",
    });

    expect(projectPatch).toEqual({ gitlabAuthToken: null, gitlabAuthTokenType: "personal" });
  });

  it("routes imported GitHub issue linking only to project settings", () => {
    const initialScopedValues = {
      global: {},
      project: { githubLinkImportedIssuesToTracking: false },
    } as never;

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload: { githubLinkImportedIssuesToTracking: true },
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(globalPatch).toEqual({});
    expect(projectPatch).toEqual({ githubLinkImportedIssuesToTracking: true });
  });

  it("routes shared mcpServers only to the active MCP scope", () => {
    expect(isGlobalSettingsKey("mcpServers")).toBe(true);
    expect(isProjectSettingsKey("mcpServers")).toBe(true);
    const globalMcp = { enabled: true, servers: [{ name: "global-docs", transport: "stdio", command: "docs" }] };
    const projectMcp = { enabled: true, servers: [{ name: "project-docs", transport: "stdio", command: "docs" }] };

    const globalResult = splitSettingsSave({
      payload: { mcpServers: globalMcp },
      initialValues: null,
      initialScopedValues: { global: { mcpServers: { enabled: false, servers: [] } }, project: { mcpServers: projectMcp } } as never,
      activeSection: "global-mcp",
    });
    expect(globalResult.globalPatch).toEqual({ mcpServers: globalMcp });
    expect(globalResult.projectPatch).toEqual({});

    const projectResult = splitSettingsSave({
      payload: { mcpServers: projectMcp },
      initialValues: null,
      initialScopedValues: { global: { mcpServers: globalMcp }, project: { mcpServers: { enabled: false, servers: [] } } } as never,
      activeSection: "mcp",
    });
    expect(projectResult.globalPatch).toEqual({});
    expect(projectResult.projectPatch).toEqual({ mcpServers: projectMcp });
  });

  it("maps flattened remote access fields to the canonical global remoteAccess patch", () => {
    const { globalPatch, projectPatch } = splitSettingsSave({
      payload: {
        remoteActiveProvider: "tailscale",
        remoteTailscaleEnabled: false,
        remoteTailscaleHostname: "tail.example.ts.net",
        remoteTailscaleTargetPort: 4040,
        remoteTailscaleAcceptRoutes: true,
        remoteCloudflareEnabled: true,
        remoteCloudflareQuickTunnel: false,
        remoteCloudflareTunnelName: "demo-tunnel",
        remoteCloudflareTunnelToken: "cf-secret-token",
        remoteCloudflareIngressUrl: "https://remote.example.com",
        remoteShortLivedEnabled: true,
        remoteShortLivedTtlMs: 120000,
        remoteShortLivedMaxTtlMs: 86400000,
        remoteRememberLastRunning: true,
        remoteWasRunningOnShutdown: true,
        remoteLastStartedProvider: "cloudflare",
      },
      initialValues: null,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "remote",
    });

    expect(projectPatch).toEqual({});
    expect(globalPatch).toEqual({
      remoteAccess: expect.objectContaining({
        activeProvider: "tailscale",
        providers: expect.objectContaining({
          tailscale: expect.objectContaining({
            enabled: true,
            hostname: "tail.example.ts.net",
            targetPort: 4040,
            acceptRoutes: true,
          }),
          cloudflare: expect.objectContaining({
            enabled: true,
            quickTunnel: false,
            tunnelName: "demo-tunnel",
            tunnelToken: "cf-secret-token",
            ingressUrl: "https://remote.example.com",
          }),
        }),
        tokenStrategy: expect.objectContaining({
          shortLived: expect.objectContaining({ enabled: true, ttlMs: 120000, maxTtlMs: 86400000 }),
        }),
        lifecycle: expect.objectContaining({
          rememberLastRunning: true,
          wasRunningOnShutdown: true,
          lastRunningProvider: "cloudflare",
        }),
      }),
    });
  });

  it("routes enabled built-in workflow ids as a changed project setting", () => {
    const { projectPatch } = splitSettingsSave({
      payload: { enabledBuiltinWorkflowIds: ["builtin:coding"] },
      initialValues: null,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ enabledBuiltinWorkflowIds: ["builtin:coding"] });
  });

  it("excludes customProviders from both global and project patches", () => {
    expect(isGlobalSettingsKey("customProviders")).toBe(true);

    const { globalPatch, projectPatch } = splitSettingsSave({
      payload: {
        customProviders: [
          {
            id: "x",
            name: "Provider X",
            baseUrl: "https://example.test/v1",
            apiKey: "secret",
            models: [{ id: "model-x", name: "Model X" }],
          },
        ],
      },
      initialValues: { customProviders: [] } as never,
      initialScopedValues: { global: { customProviders: [] }, project: {} } as never,
      activeSection: "authentication",
    });

    expect("customProviders" in globalPatch).toBe(false);
    expect("customProviders" in projectPatch).toBe(false);
  });

  it("emits null-as-delete when a project override is cleared", () => {
    const initialScopedValues = {
      global: {},
      project: { integrationBranch: "release" },
    } as never;

    const payload: Record<string, unknown> = {
      integrationBranch: undefined, // user cleared the pinned branch
    };

    const { projectPatch } = splitSettingsSave({
      payload,
      initialValues: null,
      initialScopedValues,
      activeSection: "general",
    });

    expect(projectPatch).toEqual({ integrationBranch: null });
  });

  it("emits null-as-delete for an explicit clear of a global key", () => {
    const initialValues = { ntfyTopic: "alerts" } as never;

    const payload: Record<string, unknown> = {
      ntfyTopic: undefined, // cleared; initial was defined → null
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "notifications",
    });

    expect(globalPatch).toEqual({ ntfyTopic: null });
  });

  it("drops plain-undefined global keys that were never set", () => {
    const payload: Record<string, unknown> = {
      ntfyTopic: undefined, // never had a value → passed through as undefined
    };

    const { globalPatch } = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "notifications",
    });

    expect(globalPatch).toEqual({});
  });

  it("routes GitLab URL keys to the active settings scope", () => {
    const payload: Record<string, unknown> = {
      gitlabInstanceUrl: "https://gitlab.example.com/gitlab",
      gitlabApiBaseUrl: "https://gitlab.example.com/gitlab/api/v4",
    };

    const onGlobal = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "global-general",
    });
    expect(onGlobal.globalPatch).toMatchObject(payload);
    expect("gitlabInstanceUrl" in onGlobal.projectPatch).toBe(false);
    expect("gitlabApiBaseUrl" in onGlobal.projectPatch).toBe(false);

    const onProject = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "general",
    });
    expect("gitlabInstanceUrl" in onProject.globalPatch).toBe(false);
    expect("gitlabApiBaseUrl" in onProject.globalPatch).toBe(false);
    expect(onProject.projectPatch).toMatchObject(payload);
  });

  it("clears GitLab URL overrides with null in the active settings scope", () => {
    const payload: Record<string, unknown> = { gitlabInstanceUrl: undefined, gitlabApiBaseUrl: undefined };

    const onGlobal = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: {
        global: { gitlabInstanceUrl: "https://global.example", gitlabApiBaseUrl: "https://global.example/api/v4" },
        project: {},
      } as never,
      activeSection: "global-general",
    });
    expect(onGlobal.globalPatch).toEqual({ gitlabInstanceUrl: null, gitlabApiBaseUrl: null });

    const onProject = splitSettingsSave({
      payload,
      initialValues: {} as never,
      initialScopedValues: {
        global: {},
        project: { gitlabInstanceUrl: "https://project.example", gitlabApiBaseUrl: "https://project.example/api/v4" },
      } as never,
      activeSection: "general",
    });
    expect(onProject.projectPatch).toEqual({ gitlabInstanceUrl: null, gitlabApiBaseUrl: null });
  });

  it("routes githubTrackingDefaultRepo to global only on the global-general section", () => {
    const payloadGlobal: Record<string, unknown> = { githubTrackingDefaultRepo: "org/repo" };
    const onGlobal = splitSettingsSave({
      payload: payloadGlobal,
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "global-general",
    });
    expect(onGlobal.globalPatch).toMatchObject({ githubTrackingDefaultRepo: "org/repo" });
    expect("githubTrackingDefaultRepo" in onGlobal.projectPatch).toBe(false);

    const onProject = splitSettingsSave({
      payload: { githubTrackingDefaultRepo: "org/repo" },
      initialValues: {} as never,
      initialScopedValues: { global: {}, project: {} } as never,
      activeSection: "general",
    });
    expect("githubTrackingDefaultRepo" in onProject.globalPatch).toBe(false);
    // ...and is instead routed to the project patch on the project-scoped
    // "general" section, rather than being dropped or erroring.
    expect(onProject.projectPatch).toMatchObject({ githubTrackingDefaultRepo: "org/repo" });
  });
});
