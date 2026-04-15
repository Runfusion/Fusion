import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runTaskCreate = vi.fn();
const runTaskList = vi.fn();
const runDesktop = vi.fn();
const runServe = vi.fn();
const runDaemon = vi.fn();
const runTaskPlan = vi.fn();
const runTaskImportFromGitHub = vi.fn();
const runSettingsShow = vi.fn();
const runSettingsExport = vi.fn();
const runSettingsImport = vi.fn();
const runGitStatus = vi.fn();
const runGitFetch = vi.fn();
const runBackupList = vi.fn();
const runProjectList = vi.fn();
const runProjectAdd = vi.fn();
const runProjectRemove = vi.fn();
const runProjectShow = vi.fn();
const runProjectInfo = vi.fn();
const runProjectSetDefault = vi.fn();
const runProjectDetect = vi.fn();
const runNodeList = vi.fn();
const runNodeConnect = vi.fn();
const runNodeDisconnect = vi.fn();
const runNodeShow = vi.fn();
const runNodeHealth = vi.fn();
const runMeshStatus = vi.fn();
// Legacy aliases
const runNodeAdd = vi.fn();
const runNodeRemove = vi.fn();
const runAgentStop = vi.fn();
const runAgentStart = vi.fn();
const runAgentMailbox = vi.fn();
const runAgentImport = vi.fn();
const runMessageInbox = vi.fn();
const runMessageOutbox = vi.fn();
const runMessageSend = vi.fn();
const runMessageRead = vi.fn();
const runMessageDelete = vi.fn();

vi.mock("../commands/dashboard.js", () => ({
  runDashboard: vi.fn(),
}));

vi.mock("../commands/desktop.js", () => ({
  runDesktop,
}));

vi.mock("../commands/serve.js", () => ({
  runServe,
}));

vi.mock("../commands/daemon.js", () => ({
  runDaemon,
}));

vi.mock("../commands/task.js", () => ({
  runTaskCreate,
  runTaskList,
  runTaskMove: vi.fn(),
  runTaskMerge: vi.fn(),
  runTaskUpdate: vi.fn(),
  runTaskLog: vi.fn(),
  runTaskLogs: vi.fn(),
  runTaskShow: vi.fn(),
  runTaskAttach: vi.fn(),
  runTaskPause: vi.fn(),
  runTaskUnpause: vi.fn(),
  runTaskImportFromGitHub,
  runTaskImportGitHubInteractive: vi.fn(),
  runTaskDuplicate: vi.fn(),
  runTaskArchive: vi.fn(),
  runTaskUnarchive: vi.fn(),
  runTaskRefine: vi.fn(),
  runTaskPlan,
  runTaskDelete: vi.fn(),
  runTaskRetry: vi.fn(),
  runTaskComment: vi.fn(),
  runTaskComments: vi.fn(),
  runTaskSteer: vi.fn(),
  runTaskPrCreate: vi.fn(),
}));

vi.mock("../commands/settings.js", () => ({
  runSettingsShow,
  runSettingsSet: vi.fn(),
}));

vi.mock("../commands/settings-export.js", () => ({ runSettingsExport }));
vi.mock("../commands/settings-import.js", () => ({ runSettingsImport }));

vi.mock("../commands/git.js", () => ({
  runGitStatus,
  runGitFetch,
  runGitPull: vi.fn(),
  runGitPush: vi.fn(),
}));

vi.mock("../commands/backup.js", () => ({
  runBackupCreate: vi.fn(),
  runBackupList,
  runBackupRestore: vi.fn(),
  runBackupCleanup: vi.fn(),
}));

vi.mock("../commands/project.js", () => ({
  runProjectList,
  runProjectAdd,
  runProjectRemove,
  runProjectShow,
  runProjectInfo,
  runProjectSetDefault,
  runProjectDetect,
}));

vi.mock("../commands/node.js", () => ({
  runNodeList,
  runNodeConnect,
  runNodeDisconnect,
  runNodeShow,
  runNodeHealth,
  runMeshStatus,
  // Legacy aliases
  runNodeAdd,
  runNodeRemove,
}));

vi.mock("../commands/agent.js", () => ({
  runAgentStop,
  runAgentStart,
}));

vi.mock("../commands/agent-import.js", () => ({
  runAgentImport,
}));

vi.mock("../commands/message.js", () => ({
  runMessageInbox,
  runMessageOutbox,
  runMessageSend,
  runMessageRead,
  runMessageDelete,
  runAgentMailbox,
}));

describe("bin", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalArgv = process.argv;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  async function runBin(args: string[]) {
    process.argv = ["node", "bin", ...args];
    vi.resetModules();
    return import("../bin.ts");
  }

  it("routes task list with --project before subcommand", async () => {
    await runBin(["--project", "my-app", "task", "list"]);
    expect(runTaskList).toHaveBeenCalledWith("my-app");
  });

  it("preserves legacy task list behavior when project flag is absent", async () => {
    await runBin(["task", "list"]);
    expect(runTaskList).toHaveBeenCalledWith(undefined);
  });

  it("routes task import with short -P and preserves other flags", async () => {
    await runBin(["task", "import", "owner/repo", "-P", "my-app", "--limit", "10", "--labels", "bug,help-wanted"]);
    expect(runTaskImportFromGitHub).toHaveBeenCalledWith("owner/repo", { limit: 10, labels: ["bug", "help-wanted"] }, "my-app");
  });

  it("strips --project before parsing free-form task create arguments", async () => {
    await runBin(["task", "create", "Fix", "login", "--attach", "spec.md", "--project", "demo"]);
    expect(runTaskCreate).toHaveBeenCalledWith("Fix login", ["spec.md"], undefined, "demo");
  });

  it("strips --project before parsing free-form task plan arguments", async () => {
    await runBin(["task", "plan", "Fix", "auth", "--project", "demo", "--yes"]);
    expect(runTaskPlan).toHaveBeenCalledWith("Fix auth", true, "demo");
  });

  it("passes projectName to settings, git, and backup handlers", async () => {
    await runBin(["settings", "--project", "my-app"]);
    expect(runSettingsShow).toHaveBeenCalledWith("my-app");

    await runBin(["git", "status", "--project", "my-app"]);
    expect(runGitStatus).toHaveBeenCalledWith("my-app");

    await runBin(["backup", "--list", "--project", "my-app"]);
    expect(runBackupList).toHaveBeenCalledWith("my-app");
  });

  it("passes projectName through to settings export and import handlers", async () => {
    await runBin(["settings", "export", "--project", "demo", "--scope", "project"]);
    expect(runSettingsExport).toHaveBeenCalledWith({ scope: "project", output: undefined, projectName: "demo" });

    await runBin(["settings", "import", "settings.json", "--project", "demo", "--yes"]);
    expect(runSettingsImport).toHaveBeenCalledWith("settings.json", { scope: "both", merge: false, yes: true, projectName: "demo" });
  });

  it("passes projectName through to git fetch handler without leaking args", async () => {
    await runBin(["git", "fetch", "origin", "--project", "demo"]);
    expect(runGitFetch).toHaveBeenCalledWith("origin", "demo");
  });

  it("passes projectName through to agent import handler", async () => {
    await runBin(["agent", "import", "./agents.sh", "--dry-run", "--skip-existing", "--project", "demo"]);
    expect(runAgentImport).toHaveBeenCalledWith("./agents.sh", {
      dryRun: true,
      skipExisting: true,
      project: "demo",
    });
  });

  it("parses multi-word message send content and project flag", async () => {
    await runBin(["message", "send", "agent-123", "Hello", "from", "CLI", "--project", "demo"]);
    expect(runMessageSend).toHaveBeenCalledWith("agent-123", "Hello from CLI", "demo");
  });

  it("routes project subcommands and aliases", async () => {
    await runBin(["project", "list"]);
    await runBin(["project", "ls"]);
    expect(runProjectList).toHaveBeenCalledTimes(2);

    await runBin(["project", "add", "my-app", "/tmp/my-app", "--isolation", "child-process", "--force"]);
    expect(runProjectAdd).toHaveBeenCalledWith("my-app", "/tmp/my-app", { isolation: "child-process", force: true, interactive: false });

    await runBin(["project", "remove", "my-app", "--force"]);
    await runBin(["project", "rm", "my-app", "--force"]);
    expect(runProjectRemove).toHaveBeenCalledWith("my-app", { force: true });

    await runBin(["project", "show", "my-app"]);
    expect(runProjectShow).toHaveBeenCalledWith("my-app");

    await runBin(["project", "set-default", "my-app"]);
    await runBin(["project", "default", "my-app"]);
    expect(runProjectSetDefault).toHaveBeenCalledWith("my-app");

    await runBin(["project", "detect"]);
    expect(runProjectDetect).toHaveBeenCalled();
  });

  it("rejects unknown project subcommands", async () => {
    await expect(runBin(["project", "wat"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: project wat");
  });

  it("routes node subcommands and aliases", async () => {
    await runBin(["node", "list"]);
    await runBin(["node", "ls", "--json"]);
    expect(runNodeList).toHaveBeenNthCalledWith(1, { json: false });
    expect(runNodeList).toHaveBeenNthCalledWith(2, { json: true });

    // connect is the primary command
    await runBin(["node", "connect", "my-node", "--url", "https://node.example.com", "--api-key", "abc", "--max-concurrent", "3"]);
    expect(runNodeConnect).toHaveBeenCalledWith("my-node", {
      url: "https://node.example.com",
      apiKey: "abc",
      maxConcurrent: 3,
    });

    // add is a legacy alias for connect
    await runBin(["node", "add", "my-node2", "--url", "https://node2.example.com"]);
    expect(runNodeConnect).toHaveBeenCalledWith("my-node2", {
      url: "https://node2.example.com",
    });

    await runBin(["node", "disconnect", "my-node", "--force"]);
    expect(runNodeDisconnect).toHaveBeenCalledWith("my-node", { force: true });

    await runBin(["node", "remove", "my-node", "--force"]);
    await runBin(["node", "rm", "my-node", "--force"]);
    expect(runNodeDisconnect).toHaveBeenCalledWith("my-node", { force: true });

    await runBin(["node", "show", "my-node"]);
    await runBin(["node", "info", "my-node"]);
    expect(runNodeShow).toHaveBeenCalledWith("my-node", { json: false });

    await runBin(["node", "show", "my-node", "--json"]);
    expect(runNodeShow).toHaveBeenCalledWith("my-node", { json: true });

    await runBin(["node", "health", "my-node"]);
    expect(runNodeHealth).toHaveBeenCalledWith("my-node");
  });

  it("routes mesh status command", async () => {
    await runBin(["mesh", "status"]);
    expect(runMeshStatus).toHaveBeenCalledWith({ json: false });

    await runBin(["mesh", "status", "--json"]);
    expect(runMeshStatus).toHaveBeenCalledWith({ json: true });
  });

  it("rejects unknown node subcommands", async () => {
    await expect(runBin(["node", "wat"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: node wat");
  });

  it("rejects unknown mesh subcommands", async () => {
    await expect(runBin(["mesh", "wat"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: mesh wat");
  });

  it("routes serve command with port, host, paused, and interactive flags", async () => {
    await runBin(["serve", "--port", "5050", "--host", "127.0.0.1", "--paused", "--interactive"]);

    expect(runServe).toHaveBeenCalledWith(5050, {
      paused: true,
      interactive: true,
      host: "127.0.0.1",
      daemon: false,
    });
  });

  it("routes serve command with --daemon flag", async () => {
    await runBin(["serve", "--daemon"]);

    expect(runServe).toHaveBeenCalledWith(4040, {
      paused: false,
      interactive: false,
      host: undefined,
      daemon: true,
    });
  });

  it("routes serve command with --daemon flag combined with other options", async () => {
    await runBin(["serve", "--port", "6060", "--daemon", "--host", "0.0.0.0"]);

    expect(runServe).toHaveBeenCalledWith(6060, {
      paused: false,
      interactive: false,
      host: "0.0.0.0",
      daemon: true,
    });
  });

  it("routes daemon command with port, host, token, paused, and token-only flags", async () => {
    await runBin(["daemon", "--port", "4040", "--host", "127.0.0.1", "--token", "fn_abc123", "--paused", "--token-only"]);

    expect(runDaemon).toHaveBeenCalledWith({
      port: 4040,
      paused: true,
      interactive: false,
      host: "127.0.0.1",
      token: "fn_abc123",
      tokenOnly: true,
    });
  });

  it("routes daemon command with default port 0 for random assignment", async () => {
    await runBin(["daemon"]);

    expect(runDaemon).toHaveBeenCalledWith({
      port: 0,
      paused: false,
      interactive: false,
      host: undefined,
      token: undefined,
      tokenOnly: false,
    });
  });

  it("routes desktop command flags", async () => {
    await runBin(["desktop", "--dev", "--paused", "--interactive"]);

    expect(runDesktop).toHaveBeenCalledWith({
      paused: true,
      dev: true,
      interactive: true,
    });
  });

  it("rejects duplicate --project flags", async () => {
    await expect(runBin(["task", "list", "--project", "one", "-P", "two"]))
      .rejects.toThrow("Duplicate --project flag. Specify a project only once.");
  });

  it("rejects missing --project value", async () => {
    await expect(runBin(["task", "list", "--project"]))
      .rejects.toThrow("Usage: --project <name>");
  });

  it("shows help when --project is combined with global help", async () => {
    await expect(runBin(["--project", "demo", "--help"]))
      .rejects.toThrow("process.exit:0");

    const help = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(help).toContain("fn project list | ls");
    expect(help).toContain("fn node list | ls");
    expect(runTaskList).not.toHaveBeenCalled();
  });

  it("prioritizes subcommand help after stripping --project", async () => {
    await expect(runBin(["task", "list", "--project", "demo", "-h"]))
      .rejects.toThrow("process.exit:0");

    const help = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(help).toContain("--project, -P <name>");
    expect(runTaskList).not.toHaveBeenCalled();
  });

  it("help output documents project commands, task comments, and project flag", async () => {
    await expect(runBin(["--help"]))
      .rejects.toThrow("process.exit:0");

    const help = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(help).toContain("fn project list | ls");
    expect(help).toContain("fn node list | ls");
    expect(help).toContain("fn serve [--port <port>] [--host <host>] [--paused] [--daemon]");
    expect(help).toContain("fn task comments <id>");
    expect(help).toContain("--project, -P <name>");
  });
});
