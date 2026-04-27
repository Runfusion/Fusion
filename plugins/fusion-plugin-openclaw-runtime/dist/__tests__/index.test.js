import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { mockResolveGatewayConfig, mockCreateGatewaySession, mockPromptGateway, mockDescribeGatewayModel, mockProbeGateway, } = vi.hoisted(() => ({
    mockResolveGatewayConfig: vi.fn().mockReturnValue({
        gatewayUrl: "http://127.0.0.1:18789",
        gatewayToken: undefined,
        agentId: "main",
    }),
    mockCreateGatewaySession: vi.fn(),
    mockPromptGateway: vi.fn(),
    mockDescribeGatewayModel: vi.fn().mockReturnValue("openclaw/main"),
    mockProbeGateway: vi.fn().mockResolvedValue(true),
}));
vi.mock("../pi-module.js", () => ({
    resolveGatewayConfig: mockResolveGatewayConfig,
    createGatewaySession: mockCreateGatewaySession,
    promptGateway: mockPromptGateway,
    describeGatewayModel: mockDescribeGatewayModel,
    probeGateway: mockProbeGateway,
}));
import plugin, { openclawRuntimeMetadata, openclawRuntimeFactory, OPENCLAW_RUNTIME_ID } from "../index.js";
import { OpenClawRuntimeAdapter } from "../runtime-adapter.js";
function createMockContext(overrides = {}) {
    return {
        pluginId: "fusion-plugin-openclaw-runtime",
        settings: {},
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        },
        emitEvent: vi.fn(),
        taskStore: {
            getTask: vi.fn(),
        },
        ...overrides,
    };
}
describe("openclaw-runtime plugin", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockProbeGateway.mockResolvedValue(true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    describe("plugin manifest identity", () => {
        it("should have correct manifest fields", () => {
            expect(plugin.manifest.id).toBe("fusion-plugin-openclaw-runtime");
            expect(plugin.manifest.name).toBe("OpenClaw Runtime Plugin");
            expect(plugin.manifest.version).toBe("0.1.0");
            expect(plugin.manifest.description).toContain("OpenClaw");
            expect(plugin.manifest.author).toBe("Fusion Team");
            expect(plugin.state).toBe("installed");
        });
    });
    describe("runtime registration", () => {
        it("should register openclaw runtime metadata", () => {
            expect(plugin.runtime).toBeDefined();
            expect(plugin.runtime?.metadata.runtimeId).toBe(OPENCLAW_RUNTIME_ID);
            expect(plugin.runtime?.metadata.name).toBe("OpenClaw Runtime");
            expect(plugin.runtime?.metadata.description).toContain("OpenClaw-backed AI session");
            expect(plugin.runtime?.metadata.version).toBe("0.1.0");
        });
        it("should have consistent runtime metadata between export and manifest", () => {
            expect(plugin.manifest.runtime).toEqual(openclawRuntimeMetadata);
            expect(plugin.runtime?.metadata).toEqual(openclawRuntimeMetadata);
        });
    });
    describe("hooks", () => {
        it("onLoad should probe gateway, log startup message, and emit loaded event", async () => {
            const ctx = createMockContext();
            mockResolveGatewayConfig.mockReturnValue({
                gatewayUrl: "http://localhost:18789",
                gatewayToken: "secret-token",
                agentId: "main",
            });
            await plugin.hooks.onLoad?.(ctx);
            expect(mockProbeGateway).toHaveBeenCalledWith("http://localhost:18789");
            expect(ctx.logger.info).toHaveBeenCalledWith("OpenClaw Runtime Plugin loaded (gateway: http://localhost:18789, reachable: yes)");
            expect(ctx.logger.info.mock.calls.join(" ")).not.toContain("secret-token");
            expect(ctx.emitEvent).toHaveBeenCalledWith("openclaw-runtime:loaded", {
                runtimeId: OPENCLAW_RUNTIME_ID,
                version: "0.1.0",
                gatewayUrl: "http://localhost:18789",
                gatewayReachable: true,
            });
        });
        it("onUnload should not throw", () => {
            expect(() => plugin.hooks.onUnload?.()).not.toThrow();
        });
    });
    describe("runtime factory behavior", () => {
        it("should export runtime constants", () => {
            expect(OPENCLAW_RUNTIME_ID).toBe("openclaw");
            expect(openclawRuntimeMetadata.runtimeId).toBe("openclaw");
            expect(typeof openclawRuntimeFactory).toBe("function");
        });
        it("runtime factory should return executable runtime adapter", async () => {
            const runtime = (await openclawRuntimeFactory(createMockContext({
                settings: {
                    gatewayUrl: "http://settings-gateway:18789",
                    gatewayToken: "plugin-token",
                    agentId: "ops",
                },
            })));
            expect(mockResolveGatewayConfig).toHaveBeenCalledWith({
                gatewayUrl: "http://settings-gateway:18789",
                gatewayToken: "plugin-token",
                agentId: "ops",
            });
            expect(runtime).toBeInstanceOf(OpenClawRuntimeAdapter);
            expect(runtime.id).toBe("openclaw");
            expect(runtime.name).toBe("OpenClaw Runtime");
            expect(runtime).not.toHaveProperty("status");
            expect(runtime).not.toHaveProperty("execute");
        });
        it("factory creation should not throw", async () => {
            await expect(openclawRuntimeFactory(createMockContext())).resolves.toBeInstanceOf(OpenClawRuntimeAdapter);
        });
    });
});
//# sourceMappingURL=index.test.js.map