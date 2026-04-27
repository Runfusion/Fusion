import { describe, it, expect, vi, beforeEach } from "vitest";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";
const { mockCreateStreamSession, mockStreamPrompt, mockDescribeStreamModel, } = vi.hoisted(() => ({
    mockCreateStreamSession: vi.fn(),
    mockStreamPrompt: vi.fn(),
    mockDescribeStreamModel: vi.fn(),
}));
vi.mock("../pi-module.js", () => ({
    createStreamSession: mockCreateStreamSession,
    streamPrompt: mockStreamPrompt,
    describeStreamModel: mockDescribeStreamModel,
}));
describe("HermesRuntimeAdapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("has stable runtime identity", () => {
        const adapter = new HermesRuntimeAdapter({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
        expect(adapter.id).toBe("hermes");
        expect(adapter.name).toBe("Hermes Runtime");
    });
    it("createSession passes model config/systemPrompt/callbacks and returns undefined sessionFile", async () => {
        const adapter = new HermesRuntimeAdapter({
            provider: "openai",
            modelId: "gpt-5",
            apiKey: "secret",
            thinkingLevel: "high",
        });
        const session = { messages: [], dispose: vi.fn() };
        mockCreateStreamSession.mockReturnValue(session);
        const onText = vi.fn();
        const onThinking = vi.fn();
        const onToolStart = vi.fn();
        const onToolEnd = vi.fn();
        const result = await adapter.createSession({
            cwd: "/tmp/project",
            systemPrompt: "You are Hermes",
            tools: "coding",
            customTools: [{ name: "ignored" }],
            sessionManager: { foo: "bar" },
            skillSelection: { all: true },
            skills: ["bash"],
            onText,
            onThinking,
            onToolStart,
            onToolEnd,
        });
        expect(mockCreateStreamSession).toHaveBeenCalledWith({
            provider: "openai",
            modelId: "gpt-5",
            apiKey: "secret",
            thinkingLevel: "high",
            systemPrompt: "You are Hermes",
            callbacks: {
                onText,
                onThinking,
                onToolStart,
                onToolEnd,
            },
        });
        expect(result).toEqual({ session, sessionFile: undefined });
        expect(JSON.stringify(mockCreateStreamSession.mock.calls[0][0])).not.toContain("/tmp/project");
        expect(JSON.stringify(mockCreateStreamSession.mock.calls[0][0])).not.toContain("coding");
    });
    it("promptWithFallback appends user message then delegates to streamPrompt", async () => {
        const adapter = new HermesRuntimeAdapter({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
        const session = { messages: [], dispose: vi.fn() };
        await adapter.promptWithFallback(session, "Hello from Hermes");
        expect(session.messages).toEqual([{ role: "user", content: "Hello from Hermes" }]);
        expect(mockStreamPrompt).toHaveBeenCalledWith(session, {
            role: "user",
            content: "Hello from Hermes",
        });
    });
    it("describeModel delegates to describeStreamModel", () => {
        const adapter = new HermesRuntimeAdapter({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
        const session = { messages: [], dispose: vi.fn() };
        mockDescribeStreamModel.mockReturnValue("anthropic/claude-sonnet-4-5");
        expect(adapter.describeModel(session)).toBe("anthropic/claude-sonnet-4-5");
        expect(mockDescribeStreamModel).toHaveBeenCalledWith(session);
    });
    it("dispose is a no-op when missing and calls dispose when present", async () => {
        const adapter = new HermesRuntimeAdapter({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
        const dispose = vi.fn();
        await expect(adapter.dispose({ messages: [], dispose })).resolves.toBeUndefined();
        await expect(adapter.dispose({ messages: [] })).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=runtime-adapter.test.js.map