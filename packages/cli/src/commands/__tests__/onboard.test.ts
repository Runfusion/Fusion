import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunInit = vi.fn(async () => {});
const mockResolveProject = vi.fn();
const mockProviderAuthFactory = vi.fn();
const mockGetDefaultCentralDbPath = vi.fn();

const globalSettingsState: Record<string, any> = {};

class MockGlobalSettingsStore {
  async init() {}
  async getSettings() {
    return { ...globalSettingsState };
  }
  async updateSettings(update: Record<string, any>) {
    Object.assign(globalSettingsState, update);
  }
}

const centralInitMock = vi.fn(async () => {});
const centralCloseMock = vi.fn(async () => {});
class MockCentralCore {
  async init() {
    await centralInitMock();
  }
  async close() {
    await centralCloseMock();
  }
}

vi.mock("../init.js", () => ({ runInit: mockRunInit }));
vi.mock("../project-context.js", () => ({ resolveProject: mockResolveProject }));
vi.mock("../provider-auth.js", () => ({
  wrapAuthStorageWithApiKeyProviders: vi.fn(() => mockProviderAuthFactory()),
}));
vi.mock("../auth-paths.js", () => ({
  getModelRegistryModelsPath: vi.fn(() => "/tmp/models.json"),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRegistry: { create: vi.fn(() => ({})) },
}));
vi.mock("@fusion/engine", () => ({
  createFusionAuthStorage: vi.fn(() => ({})),
}));
vi.mock("@fusion/core", () => ({
  CentralCore: MockCentralCore,
  GlobalSettingsStore: MockGlobalSettingsStore,
  getDefaultCentralDbPath: mockGetDefaultCentralDbPath,
}));

const { __testUtils, runOnboard } = await import("../onboard.js");

function inputFrom(lines: string[]): PassThrough {
  const input = new PassThrough();
  let index = 0;
  const pump = () => {
    if (index >= lines.length) {
      input.end();
      return;
    }
    input.write(`${lines[index++]}\n`);
    setTimeout(pump, 1);
  };
  setTimeout(pump, 0);
  return input;
}

function makeProviderAuth() {
  return {
    getApiKeyProviders: vi.fn(() => [
      { id: "openrouter", name: "OpenRouter" },
      { id: "openai-codex", name: "Codex" },
    ]),
    getOAuthProviders: vi.fn(() => [{ id: "openai-codex", name: "Codex" }]),
    hasApiKey: vi.fn(() => false),
    hasAuth: vi.fn(() => false),
    setApiKey: vi.fn(),
  };
}

describe("onboard", () => {
  it("isCliOnboardingComplete handles marker presence correctly", () => {
    expect(__testUtils.isCliOnboardingComplete({})).toBe(false);
    expect(__testUtils.isCliOnboardingComplete({ cliOnboardingCompletedAt: "" })).toBe(false);
    expect(__testUtils.isCliOnboardingComplete({ cliOnboardingCompletedAt: "2026-06-01T00:00:00.000Z" })).toBe(
      true,
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(globalSettingsState)) delete globalSettingsState[key];
    mockGetDefaultCentralDbPath.mockReturnValue(join(mkdtempSync(join(tmpdir(), "fn-onboard-db-")), "fusion-central.db"));
    mockResolveProject.mockRejectedValue(new Error("no project"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prompt helper supports defaults, explicit input, yes/no parsing, and choice/skip", async () => {
    const defaultSession = __testUtils.createPromptSession(inputFrom([""]));
    await expect(defaultSession.prompt("Name", "default")).resolves.toBe("default");
    defaultSession.close();

    const explicitSession = __testUtils.createPromptSession(inputFrom(["value", "yes"]));
    await expect(explicitSession.prompt("Name")).resolves.toBe("value");
    await expect(explicitSession.promptYesNo("Proceed", false)).resolves.toBe(true);
    explicitSession.close();

    const choiceSession = __testUtils.createPromptSession(inputFrom(["2", "2"]));
    await expect(
      choiceSession.promptChoice(
        "Provider",
        [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        { allowSkip: true },
      ),
    ).resolves.toBe("b");
    await expect(
      choiceSession.promptChoice("Provider", [{ id: "a", label: "A" }], { allowSkip: true }),
    ).resolves.toBeUndefined();
    choiceSession.close();
  });

  it("runOnboard initializes central db when missing", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runOnboard({
      input: inputFrom(["y", "y", "3", "y", "y", "n", "y"]),
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Creating central DB"));
    expect(centralInitMock).toHaveBeenCalled();
  });

  it("runOnboard reports central db already exists", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);
    const existingPath = mockGetDefaultCentralDbPath();
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(existingPath, "db");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runOnboard({ input: inputFrom(["y", "3", "y", "y", "n", "y"]) });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Central DB already exists"));
  });

  it("stores API key, runs init, persists global testMode and completion marker", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runOnboard({ input: inputFrom(["y", "y", "1", "test-key", "y", "y", "y", "y"]) });

    expect(providerAuth.setApiKey).toHaveBeenCalledWith("openrouter", "test-key");
    expect(mockRunInit).toHaveBeenCalledTimes(1);
    expect(globalSettingsState.testMode).toBe(true);
    expect(typeof globalSettingsState.cliOnboardingCompletedAt).toBe("string");
    expect(logSpy).toHaveBeenCalledWith("  fn dashboard      # launch dashboard");
    expect(logSpy).toHaveBeenCalledWith("  fn task create    # create your first task");
    expect(globalSettingsState.setupComplete).toBeUndefined();
  });

  it("re-runs only with force when marker already exists", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalSettingsState.cliOnboardingCompletedAt = "2026-06-01T00:00:00.000Z";

    await runOnboard({ input: inputFrom(["y", "3", "y", "y", "n", "y"]) });
    expect(logSpy).toHaveBeenCalledWith("Onboarding already completed. Re-run with --force to run it again.");
    expect(providerAuth.setApiKey).not.toHaveBeenCalled();
    expect(mockRunInit).not.toHaveBeenCalled();

    await runOnboard({ force: true, input: inputFrom(["y", "n", "n", "n", "n"]) });
    expect(globalSettingsState.cliOnboardingCompletedAt).not.toBe("2026-06-01T00:00:00.000Z");
  });

  it("validates bad maxConcurrent locally without process exit", () => {
    expect(() => __testUtils.validateMaxConcurrent("99")).toThrow(
      "maxConcurrent must be an integer between 1 and 10.",
    );
  });

  it("cleans up SIGINT listeners when prompt is cancelled", async () => {
    const input = new PassThrough();
    const before = process.listenerCount("SIGINT");
    const session = __testUtils.createPromptSession(input);
    const during = process.listenerCount("SIGINT");
    expect(during).toBeGreaterThanOrEqual(before);

    const pending = session.prompt("Name");
    process.emit("SIGINT");
    await expect(pending).rejects.toThrow(__testUtils.PROMPT_CANCELLED_ERROR);
    session.close();
    expect(process.listenerCount("SIGINT")).toBeLessThanOrEqual(before);
  });

  it("runSkippableStep declines without running body and accepts once", async () => {
    const declineSession = __testUtils.createPromptSession(inputFrom(["n"]));
    const declineBody = vi.fn(async () => {});
    await expect(__testUtils.runSkippableStep(declineSession, "Sample", declineBody)).resolves.toBe(false);
    expect(declineBody).not.toHaveBeenCalled();
    declineSession.close();

    const acceptSession = __testUtils.createPromptSession(inputFrom(["y"]));
    const acceptBody = vi.fn(async () => {});
    await expect(__testUtils.runSkippableStep(acceptSession, "Sample", acceptBody)).resolves.toBe(true);
    expect(acceptBody).toHaveBeenCalledTimes(1);
    acceptSession.close();
  });

  it("allows fully skipping onboarding steps while still persisting completion marker", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);

    await runOnboard({ input: inputFrom(["n", "n", "n", "n", "n"]) });

    expect(centralInitMock).not.toHaveBeenCalled();
    expect(mockRunInit).not.toHaveBeenCalled();
    expect(globalSettingsState.testMode).toBeUndefined();
    expect(typeof globalSettingsState.cliOnboardingCompletedAt).toBe("string");
    expect(providerAuth.setApiKey).not.toHaveBeenCalled();
  });

  it("supports selective skip for provider while running init and settings", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);

    await runOnboard({ input: inputFrom(["y", "n", "y", "y", "n", "y"]) });
    expect(providerAuth.setApiKey).not.toHaveBeenCalled();
    expect(mockRunInit).toHaveBeenCalledTimes(1);
    expect(globalSettingsState.testMode).toBe(false);
    expect(typeof globalSettingsState.cliOnboardingCompletedAt).toBe("string");
  });

  it("supports selective skip for project setup while other steps run", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);

    await runOnboard({ input: inputFrom(["y", "y", "3", "n", "y", "n", "y"]) });
    expect(mockRunInit).not.toHaveBeenCalled();
    expect(globalSettingsState.testMode).toBe(false);
    expect(typeof globalSettingsState.cliOnboardingCompletedAt).toBe("string");
  });

  it("treats cancellation distinctly from skip and does not persist completion", async () => {
    const providerAuth = makeProviderAuth();
    mockProviderAuthFactory.mockReturnValue(providerAuth);
    const cancelledInput = new PassThrough();
    cancelledInput.end();

    await expect(runOnboard({ input: cancelledInput })).rejects.toThrow("Onboarding cancelled.");
    expect(globalSettingsState.cliOnboardingCompletedAt).toBeUndefined();
  });
});
