import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const commandMocks = vi.hoisted(() => ({
  runDashboard: vi.fn(),
  runServe: vi.fn(),
  runDaemon: vi.fn(),
  runDesktop: vi.fn(),
  runInit: vi.fn(),

  runTaskCreate: vi.fn(),
  runTaskList: vi.fn(),
  runTaskMove: vi.fn(),
  runTaskMerge: vi.fn(),
  runTaskUpdate: vi.fn(),
  runTaskLog: vi.fn(),
  runTaskLogs: vi.fn(),
  runTaskShow: vi.fn(),
  runTaskAttach: vi.fn(),
  runTaskPause: vi.fn(),
  runTaskUnpause: vi.fn(),
  runTaskImportFromGitHub: vi.fn(),
  runTaskImportGitHubInteractive: vi.fn(),
  runTaskDuplicate: vi.fn(),
  runTaskArchive: vi.fn(),
  runTaskUnarchive: vi.fn(),
  runTaskRefine: vi.fn(),
  runTaskPlan: vi.fn(),
  runTaskDelete: vi.fn(),
  runTaskRetry: vi.fn(),
  runTaskComment: vi.fn(),
  runTaskComments: vi.fn(),
  runTaskSteer: vi.fn(),
  runTaskSetNode: vi.fn(),
  runTaskClearNode: vi.fn(),
  runTaskPrCreate: vi.fn(),

  runSettingsShow: vi.fn(),
  runSettingsSet: vi.fn(),
  runSettingsExport: vi.fn(),
  runSettingsImport: vi.fn(),

  runGitStatus: vi.fn(),
  runGitFetch: vi.fn(),
  runGitPull: vi.fn(),
  runGitPush: vi.fn(),

  runBackupCreate: vi.fn(),
  runBackupList: vi.fn(),
  runBackupRestore: vi.fn(),
  runBackupCleanup: vi.fn(),

  runMissionCreate: vi.fn(),
  runMissionList: vi.fn(),
  runMissionShow: vi.fn(),
  runMissionDelete: vi.fn(),
  runMissionActivateSlice: vi.fn(),

  runProjectList: vi.fn(),
  runProjectAdd: vi.fn(),
  runProjectRemove: vi.fn(),
  runProjectShow: vi.fn(),
  runProjectInfo: vi.fn(),
  runProjectSetDefault: vi.fn(),
  runProjectDetect: vi.fn(),

  runNodeList: vi.fn(),
  runNodeConnect: vi.fn(),
  runNodeDisconnect: vi.fn(),
  runNodeShow: vi.fn(),
  runNodeHealth: vi.fn(),
  runMeshStatus: vi.fn(),
  // Legacy aliases
  runNodeAdd: vi.fn(),
  runNodeRemove: vi.fn(),

  runAgentStop: vi.fn(),
  runAgentStart: vi.fn(),
  runAgentImport: vi.fn(),

  runMessageInbox: vi.fn(),
  runMessageOutbox: vi.fn(),
  runMessageSend: vi.fn(),
  runMessageRead: vi.fn(),
  runMessageDelete: vi.fn(),
  runAgentMailbox: vi.fn(),

  runPluginList: vi.fn(),
  runPluginInstall: vi.fn(),
  runPluginUninstall: vi.fn(),
  runPluginEnable: vi.fn(),
  runPluginDisable: vi.fn(),
  runPluginSetupStatus: vi.fn(),
  runPluginSetup: vi.fn(),
  runPluginAvailable: vi.fn(),
  runPluginSettings: vi.fn(),
  runPluginRescan: vi.fn(),
  runPluginCreate: vi.fn(),

  runResearchCreate: vi.fn(),
  runResearchList: vi.fn(),
  runResearchShow: vi.fn(),
  runResearchExport: vi.fn(),
  runResearchCancel: vi.fn(),
  runResearchRetry: vi.fn(),
}));

vi.mock("../commands/dashboard.js", () => ({ runDashboard: commandMocks.runDashboard }));
vi.mock("../commands/serve.js", () => ({ runServe: commandMocks.runServe }));
vi.mock("../commands/daemon.js", () => ({ runDaemon: commandMocks.runDaemon }));
vi.mock("../commands/desktop.js", () => ({ runDesktop: commandMocks.runDesktop }));
vi.mock("../commands/init.js", () => ({ runInit: commandMocks.runInit }));

vi.mock("../commands/task.js", () => ({
  runTaskCreate: commandMocks.runTaskCreate,
  runTaskList: commandMocks.runTaskList,
  runTaskMove: commandMocks.runTaskMove,
  runTaskMerge: commandMocks.runTaskMerge,
  runTaskUpdate: commandMocks.runTaskUpdate,
  runTaskLog: commandMocks.runTaskLog,
  runTaskLogs: commandMocks.runTaskLogs,
  runTaskShow: commandMocks.runTaskShow,
  runTaskAttach: commandMocks.runTaskAttach,
  runTaskPause: commandMocks.runTaskPause,
  runTaskUnpause: commandMocks.runTaskUnpause,
  runTaskImportFromGitHub: commandMocks.runTaskImportFromGitHub,
  runTaskImportGitHubInteractive: commandMocks.runTaskImportGitHubInteractive,
  runTaskDuplicate: commandMocks.runTaskDuplicate,
  runTaskArchive: commandMocks.runTaskArchive,
  runTaskUnarchive: commandMocks.runTaskUnarchive,
  runTaskRefine: commandMocks.runTaskRefine,
  runTaskPlan: commandMocks.runTaskPlan,
  runTaskDelete: commandMocks.runTaskDelete,
  runTaskRetry: commandMocks.runTaskRetry,
  runTaskComment: commandMocks.runTaskComment,
  runTaskComments: commandMocks.runTaskComments,
  runTaskSteer: commandMocks.runTaskSteer,
  runTaskSetNode: commandMocks.runTaskSetNode,
  runTaskClearNode: commandMocks.runTaskClearNode,
  runTaskPrCreate: commandMocks.runTaskPrCreate,
}));

vi.mock("../commands/settings.js", () => ({
  runSettingsShow: commandMocks.runSettingsShow,
  runSettingsSet: commandMocks.runSettingsSet,
}));
vi.mock("../commands/settings-export.js", () => ({ runSettingsExport: commandMocks.runSettingsExport }));
vi.mock("../commands/settings-import.js", () => ({ runSettingsImport: commandMocks.runSettingsImport }));

vi.mock("../commands/git.js", () => ({
  runGitStatus: commandMocks.runGitStatus,
  runGitFetch: commandMocks.runGitFetch,
  runGitPull: commandMocks.runGitPull,
  runGitPush: commandMocks.runGitPush,
}));

vi.mock("../commands/backup.js", () => ({
  runBackupCreate: commandMocks.runBackupCreate,
  runBackupList: commandMocks.runBackupList,
  runBackupRestore: commandMocks.runBackupRestore,
  runBackupCleanup: commandMocks.runBackupCleanup,
}));

vi.mock("../commands/mission.js", () => ({
  runMissionCreate: commandMocks.runMissionCreate,
  runMissionList: commandMocks.runMissionList,
  runMissionShow: commandMocks.runMissionShow,
  runMissionDelete: commandMocks.runMissionDelete,
  runMissionActivateSlice: commandMocks.runMissionActivateSlice,
}));

vi.mock("../commands/project.js", () => ({
  runProjectList: commandMocks.runProjectList,
  runProjectAdd: commandMocks.runProjectAdd,
  runProjectRemove: commandMocks.runProjectRemove,
  runProjectShow: commandMocks.runProjectShow,
  runProjectInfo: commandMocks.runProjectInfo,
  runProjectSetDefault: commandMocks.runProjectSetDefault,
  runProjectDetect: commandMocks.runProjectDetect,
}));

vi.mock("../commands/node.js", () => ({
  runNodeList: commandMocks.runNodeList,
  runNodeConnect: commandMocks.runNodeConnect,
  runNodeDisconnect: commandMocks.runNodeDisconnect,
  runNodeShow: commandMocks.runNodeShow,
  runNodeHealth: commandMocks.runNodeHealth,
  runMeshStatus: commandMocks.runMeshStatus,
  // Legacy aliases
  runNodeAdd: commandMocks.runNodeAdd,
  runNodeRemove: commandMocks.runNodeRemove,
}));

vi.mock("../commands/agent.js", () => ({
  runAgentStop: commandMocks.runAgentStop,
  runAgentStart: commandMocks.runAgentStart,
}));

vi.mock("../commands/agent-import.js", () => ({
  runAgentImport: commandMocks.runAgentImport,
}));

vi.mock("../commands/message.js", () => ({
  runMessageInbox: commandMocks.runMessageInbox,
  runMessageOutbox: commandMocks.runMessageOutbox,
  runMessageSend: commandMocks.runMessageSend,
  runMessageRead: commandMocks.runMessageRead,
  runMessageDelete: commandMocks.runMessageDelete,
  runAgentMailbox: commandMocks.runAgentMailbox,
}));

vi.mock("../commands/plugin.js", () => ({
  runPluginList: commandMocks.runPluginList,
  runPluginInstall: commandMocks.runPluginInstall,
  runPluginUninstall: commandMocks.runPluginUninstall,
  runPluginEnable: commandMocks.runPluginEnable,
  runPluginDisable: commandMocks.runPluginDisable,
  runPluginSetupStatus: commandMocks.runPluginSetupStatus,
  runPluginSetup: commandMocks.runPluginSetup,
  runPluginAvailable: commandMocks.runPluginAvailable,
  runPluginSettings: commandMocks.runPluginSettings,
  runPluginRescan: commandMocks.runPluginRescan,
}));

vi.mock("../commands/plugin-scaffold.js", () => ({
  runPluginCreate: commandMocks.runPluginCreate,
}));

vi.mock("../commands/research.js", () => ({
  runResearchCreate: commandMocks.runResearchCreate,
  runResearchList: commandMocks.runResearchList,
  runResearchShow: commandMocks.runResearchShow,
  runResearchExport: commandMocks.runResearchExport,
  runResearchCancel: commandMocks.runResearchCancel,
  runResearchRetry: commandMocks.runResearchRetry,
}));

const originalArgv = process.argv;
const originalExit = process.exit;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

let importCounter = 0;

async function runBin(args: string[]) {
  process.argv = ["node", "bin.ts", ...args];
  importCounter += 1;
  await import(/* @vite-ignore */ `../bin.ts?test=${importCounter}`);
}

describe("bin command routing and fallbacks", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_PACKAGE_DIR;
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;

    if (originalPiPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiPackageDir;
    }
  });

  it("configures pi to use .fusion as its project config directory", async () => {
    await expect(runBin(["--help"])).rejects.toThrow("process.exit:0");

    const piPackageDir = process.env.PI_PACKAGE_DIR;
    expect(piPackageDir).toBeTruthy();
    const pkg = JSON.parse(readFileSync(join(piPackageDir!, "package.json"), "utf-8")) as {
      piConfig?: { configDir?: string };
    };
    expect(pkg.piConfig?.configDir).toBe(".fusion");
  });

  it("shows help with --help and exits 0", async () => {
    await expect(runBin(["--help"])).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("fn — AI-orchestrated task board"));
  });

  it("includes worktrunk settings keys in help output", async () => {
    await expect(runBin(["--help"])).rejects.toThrow("process.exit:0");
    const output = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("worktrunk.enabled");
    expect(output).toContain("worktrunk.onFailure");
  });

  it(
    "launches dashboard when no args are provided",
    async () => {
      commandMocks.runDashboard.mockResolvedValue({ dispose: vi.fn() });
      await runBin([]);
      expect(commandMocks.runDashboard).toHaveBeenCalled();
    },
    15000,
  );

  it(
    "prints an error for unknown top-level command",
    async () => {
      await expect(runBin(["unknown-cmd"])).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith("Unknown command: unknown-cmd");
    },
    15000,
  );

  it("errors on duplicate --project flags", async () => {
    await expect(runBin(["task", "list", "--project", "alpha", "-P", "beta"])).rejects.toThrow(
      "Duplicate --project flag",
    );
  });

  it("errors when --project is missing a value", async () => {
    await expect(runBin(["task", "list", "--project"])).rejects.toThrow("Usage: --project <name>");
  });

  it("routes settings export with scope/output/project", async () => {
    await runBin(["settings", "export", "--scope", "global", "--output", "./out.json", "-P", "demo"]);

    expect(commandMocks.runSettingsExport).toHaveBeenCalledWith({
      scope: "global",
      output: "./out.json",
      projectName: "demo",
    });
  });

  it("routes settings import with file and flags", async () => {
    await runBin(["settings", "import", "file.json", "--scope", "global", "--merge", "--yes", "-P", "demo"]);

    expect(commandMocks.runSettingsImport).toHaveBeenCalledWith("file.json", {
      scope: "global",
      merge: true,
      yes: true,
      projectName: "demo",
    });
  });

  it("errors when settings import file is missing", async () => {
    await expect(runBin(["settings", "import"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      "Usage: fn settings import <file> [--scope global|project|both] [--merge] [--yes]",
    );
  });

  it("errors on unknown settings subcommand", async () => {
    await expect(runBin(["settings", "oops"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown settings subcommand: oops");
  });

  it("routes git fetch/pull/push with expected options", async () => {
    await runBin(["git", "fetch", "origin", "-P", "demo"]);
    await runBin(["git", "pull", "--yes", "-P", "demo"]);
    await runBin(["git", "push", "--yes", "-P", "demo"]);

    expect(commandMocks.runGitFetch).toHaveBeenCalledWith("origin", "demo");
    expect(commandMocks.runGitPull).toHaveBeenCalledWith({ skipConfirm: true, projectName: "demo" });
    expect(commandMocks.runGitPush).toHaveBeenCalledWith({ skipConfirm: true, projectName: "demo" });
  });

  it("errors on unknown git subcommand", async () => {
    await expect(runBin(["git", "rebase"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: git rebase");
  });

  it("routes backup create/list/cleanup/restore", async () => {
    await runBin(["backup", "--create", "-P", "demo"]);
    await runBin(["backup", "--list", "-P", "demo"]);
    await runBin(["backup", "--cleanup", "-P", "demo"]);
    await runBin(["backup", "--restore", "backup.db", "-P", "demo"]);

    expect(commandMocks.runBackupCreate).toHaveBeenCalledWith("demo");
    expect(commandMocks.runBackupList).toHaveBeenCalledWith("demo");
    expect(commandMocks.runBackupCleanup).toHaveBeenCalledWith("demo");
    expect(commandMocks.runBackupRestore).toHaveBeenCalledWith("backup.db", "demo");
  });

  it("errors when backup flags are missing", async () => {
    await expect(runBin(["backup"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      "Usage: fn backup --create | --list | --cleanup | --restore <filename>",
    );
  });

  it("errors for task move missing arguments", async () => {
    await expect(runBin(["task", "move"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Usage: fn task move <id> <column>");
  });

  it("errors for task show missing id", async () => {
    await expect(runBin(["task", "show"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Usage: fn task show <id>");
  });





  it("routes agent subcommands stop/start/import/mailbox", async () => {
    await runBin(["agent", "stop", "agent-1", "-P", "demo"]);
    await runBin(["agent", "start", "agent-1", "-P", "demo"]);
    await runBin(["agent", "import", "company.md", "--dry-run", "-P", "demo"]);
    await runBin(["agent", "mailbox", "agent-1", "-P", "demo"]);

    expect(commandMocks.runAgentStop).toHaveBeenCalledWith("agent-1", "demo");
    expect(commandMocks.runAgentStart).toHaveBeenCalledWith("agent-1", "demo");
    expect(commandMocks.runAgentImport).toHaveBeenCalledWith("company.md", {
      dryRun: true,
      skipExisting: false,
      project: "demo",
    });
    expect(commandMocks.runAgentMailbox).toHaveBeenCalledWith("agent-1", "demo");
  });

  it("routes message subcommands send/read/delete/inbox/outbox", async () => {
    await runBin(["message", "send", "agent-7", "hello", "there", "-P", "demo"]);
    await runBin(["message", "read", "msg-1", "-P", "demo"]);
    await runBin(["message", "delete", "msg-1", "-P", "demo"]);
    await runBin(["message", "inbox", "-P", "demo"]);
    await runBin(["message", "outbox", "-P", "demo"]);

    expect(commandMocks.runMessageSend).toHaveBeenCalledWith("agent-7", "hello there", "demo");
    expect(commandMocks.runMessageRead).toHaveBeenCalledWith("msg-1", "demo");
    expect(commandMocks.runMessageDelete).toHaveBeenCalledWith("msg-1", "demo");
    expect(commandMocks.runMessageInbox).toHaveBeenCalledWith("demo");
    expect(commandMocks.runMessageOutbox).toHaveBeenCalledWith("demo");
  });

  it("routes plugin install and add alias to the same install handler", async () => {
    await runBin(["plugin", "install", "fusion-plugin-hermes-runtime", "-P", "demo"]);
    await runBin(["plugin", "add", "fusion-plugin-hermes-runtime", "-P", "demo"]);

    expect(commandMocks.runPluginInstall).toHaveBeenNthCalledWith(1, "fusion-plugin-hermes-runtime", {
      projectName: "demo",
      aiScan: false,
    });
    expect(commandMocks.runPluginInstall).toHaveBeenNthCalledWith(2, "fusion-plugin-hermes-runtime", {
      projectName: "demo",
      aiScan: false,
    });
  });

  it("routes plugin available and settings", async () => {
    await runBin(["plugin", "available"]);
    await runBin(["plugin", "settings", "fusion-plugin-hermes-runtime", "enabled", "true", "-P", "demo"]);

    expect(commandMocks.runPluginAvailable).toHaveBeenCalledWith();
    expect(commandMocks.runPluginSettings).toHaveBeenCalledWith(
      "fusion-plugin-hermes-runtime",
      "enabled",
      "true",
      { projectName: "demo" },
    );
  });

  it("errors when plugin install source is missing", async () => {
    await expect(runBin(["plugin", "add"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      "Usage: fn plugin install <path-or-package> [--ai-scan] (alias: fn plugin add <path-or-package>)",
    );
  });

  it("shows plugin help guidance with install/add alias on unknown plugin subcommand", async () => {
    await expect(runBin(["plugin", "oops"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: plugin oops");
    expect(logSpy).toHaveBeenCalledWith(
      "Try: fn plugin list | install | add (alias for install) | uninstall | enable | disable | available | settings | rescan | setup-status | setup | create",
    );
  });

  it("routes node add with typed option parsing", async () => {
    await runBin([
      "node",
      "add",
      "worker-a",
      "--url",
      "http://x",
      "--api-key",
      "key",
      "--max-concurrent",
      "4",
    ]);

    expect(commandMocks.runNodeConnect).toHaveBeenCalledWith("worker-a", {
      url: "http://x",
      apiKey: "key",
      maxConcurrent: 4,
    });
  });

  it("passes extracted --project into command handlers", async () => {
    await runBin(["task", "list", "--project", "alpha"]);
    await runBin(["settings", "show", "-P", "alpha"]);

    expect(commandMocks.runTaskList).toHaveBeenCalledWith("alpha");
    expect(commandMocks.runSettingsShow).toHaveBeenCalledWith("alpha");
  });

  it("routes mission create with multi-word description and project flag", async () => {
    await runBin(["mission", "create", "Test Mission", "Detailed", "mission", "description", "--project", "demo"]);

    expect(commandMocks.runMissionCreate).toHaveBeenCalledWith(
      "Test Mission",
      "Detailed mission description",
      "demo",
    );
  });

  it.each([
    { args: ["mission", "ls"], includeDrafts: true },
    { args: ["mission", "list", "--no-drafts"], includeDrafts: false },
  ])("routes mission list variants %#", async ({ args, includeDrafts }) => {
    await runBin(args);
    expect(commandMocks.runMissionList).toHaveBeenCalledWith(undefined, { includeDrafts });
  });

  it("routes mission show alias", async () => {
    await runBin(["mission", "info", "M-001"]);
    expect(commandMocks.runMissionShow).toHaveBeenCalledWith("M-001", undefined);
  });

  it("routes mission delete with force flag", async () => {
    await runBin(["mission", "delete", "M-001", "--force"]);
    expect(commandMocks.runMissionDelete).toHaveBeenCalledWith("M-001", true, undefined);
  });

  it("routes mission activate-slice", async () => {
    await runBin(["mission", "activate-slice", "SL-001"]);
    expect(commandMocks.runMissionActivateSlice).toHaveBeenCalledWith("SL-001", undefined);
  });

  it("routes daemon command with all flags", async () => {
    await runBin(["daemon", "--port", "4040", "--host", "127.0.0.1", "--token", "fn_abc123", "--paused", "--token-only"]);

    expect(commandMocks.runDaemon).toHaveBeenCalledWith({
      port: 4040,
      paused: true,
      interactive: false,
      host: "127.0.0.1",
      token: "fn_abc123",
      tokenOnly: true,
      noAutoRegister: false,
    });
  });

  it("routes daemon command with defaults", async () => {
    await runBin(["daemon"]);

    expect(commandMocks.runDaemon).toHaveBeenCalledWith({
      port: 0,
      paused: false,
      interactive: false,
      host: undefined,
      token: undefined,
      tokenOnly: false,
      noAutoRegister: false,
    });
  });

  it("routes research create with options", async () => {
    await runBin(["research", "create", "--query", "hello world", "--wait", "--max-wait-ms", "1200", "--json", "--project", "alpha"]);
    expect(commandMocks.runResearchCreate).toHaveBeenCalledWith({
      query: "hello world",
      waitForCompletion: true,
      maxWaitMs: 1200,
      json: true,
      projectName: "alpha",
    });
  });

  it("supports positional research query and rejects missing query", async () => {
    await runBin(["research", "create", "hello", "world"]);
    expect(commandMocks.runResearchCreate).toHaveBeenCalledWith({
      query: "hello world",
      waitForCompletion: false,
      maxWaitMs: undefined,
      json: false,
      projectName: undefined,
    });

    await expect(runBin(["research", "create", "--wait"]))
      .rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Usage: fn research create --query <text> [--wait] [--max-wait-ms <ms>] [--json]");
  });

  it("routes research export", async () => {
    await runBin(["research", "export", "RR-001", "--format", "json", "--output", "./out.json"]);
    expect(commandMocks.runResearchExport).toHaveBeenCalledWith({
      runId: "RR-001",
      format: "json",
      output: "./out.json",
      json: false,
      projectName: undefined,
    });
  });

  it("routes research list/show/cancel/retry", async () => {
    await runBin(["research", "ls", "--status", "failed", "--limit", "5", "--json"]);
    await runBin(["research", "show", "RR-001", "--json"]);
    await runBin(["research", "cancel", "RR-001"]);
    await runBin(["research", "retry", "RR-002", "--json"]);

    expect(commandMocks.runResearchList).toHaveBeenCalledWith({
      status: "failed",
      limit: 5,
      json: true,
      projectName: undefined,
    });
    expect(commandMocks.runResearchShow).toHaveBeenCalledWith("RR-001", { json: true, projectName: undefined });
    expect(commandMocks.runResearchCancel).toHaveBeenCalledWith("RR-001", { json: false, projectName: undefined });
    expect(commandMocks.runResearchRetry).toHaveBeenCalledWith("RR-002", { json: true, projectName: undefined });
  });

  it("shows research subcommand guidance on unknown subcommand", async () => {
    await expect(runBin(["research", "oops"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: research oops");
    expect(logSpy).toHaveBeenCalledWith("Try: fn research create | list | show | export | cancel | retry");
  });

  it.each([
    {
      args: ["pr", "create", "FN-001", "--draft", "--no-ai", "--reviewer", "alice", "--reviewer", "bob"],
      expected: { draft: true, ai: false, reviewers: ["alice", "bob"] },
    },
    {
      args: ["task", "pr-create", "FN-001", "--draft"],
      expected: { draft: true, ai: true },
    },
  ])("routes PR creation variants %#", async ({ args, expected }) => {
    await runBin(args);
    expect(commandMocks.runTaskPrCreate).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining(expected),
      undefined,
    );
  });

  it("errors on missing pr subcommand", async () => {
    await expect(runBin(["pr"]))
      .rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: pr ");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: fn pr create <task-id>"));
  });

  it("routes task delete with allow-resurrection flag", async () => {
    await runBin(["task", "delete", "FN-1", "--force", "--allow-resurrection"]);
    expect(commandMocks.runTaskDelete).toHaveBeenCalledWith("FN-1", true, true, undefined);
  });

  it("routes task delete default allow-resurrection=false", async () => {
    await runBin(["task", "delete", "FN-1", "--force"]);
    expect(commandMocks.runTaskDelete).toHaveBeenCalledWith("FN-1", true, false, undefined);
  });

  it("routes desktop flags to runDesktop", async () => {
    await runBin(["desktop", "--dev", "--paused", "--interactive"]);
    expect(commandMocks.runDesktop).toHaveBeenCalledWith({
      paused: true,
      dev: true,
      interactive: true,
    });
  });
});
