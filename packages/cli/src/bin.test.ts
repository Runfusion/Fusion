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
}));

vi.mock("./commands/dashboard.js", () => ({ runDashboard: commandMocks.runDashboard }));
vi.mock("./commands/serve.js", () => ({ runServe: commandMocks.runServe }));
vi.mock("./commands/daemon.js", () => ({ runDaemon: commandMocks.runDaemon }));
vi.mock("./commands/desktop.js", () => ({ runDesktop: commandMocks.runDesktop }));
vi.mock("./commands/init.js", () => ({ runInit: commandMocks.runInit }));

vi.mock("./commands/task.js", () => ({
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
  runTaskPrCreate: commandMocks.runTaskPrCreate,
}));

vi.mock("./commands/settings.js", () => ({
  runSettingsShow: commandMocks.runSettingsShow,
  runSettingsSet: commandMocks.runSettingsSet,
}));
vi.mock("./commands/settings-export.js", () => ({ runSettingsExport: commandMocks.runSettingsExport }));
vi.mock("./commands/settings-import.js", () => ({ runSettingsImport: commandMocks.runSettingsImport }));

vi.mock("./commands/git.js", () => ({
  runGitStatus: commandMocks.runGitStatus,
  runGitFetch: commandMocks.runGitFetch,
  runGitPull: commandMocks.runGitPull,
  runGitPush: commandMocks.runGitPush,
}));

vi.mock("./commands/backup.js", () => ({
  runBackupCreate: commandMocks.runBackupCreate,
  runBackupList: commandMocks.runBackupList,
  runBackupRestore: commandMocks.runBackupRestore,
  runBackupCleanup: commandMocks.runBackupCleanup,
}));

vi.mock("./commands/mission.js", () => ({
  runMissionCreate: commandMocks.runMissionCreate,
  runMissionList: commandMocks.runMissionList,
  runMissionShow: commandMocks.runMissionShow,
  runMissionDelete: commandMocks.runMissionDelete,
  runMissionActivateSlice: commandMocks.runMissionActivateSlice,
}));

vi.mock("./commands/project.js", () => ({
  runProjectList: commandMocks.runProjectList,
  runProjectAdd: commandMocks.runProjectAdd,
  runProjectRemove: commandMocks.runProjectRemove,
  runProjectShow: commandMocks.runProjectShow,
  runProjectInfo: commandMocks.runProjectInfo,
  runProjectSetDefault: commandMocks.runProjectSetDefault,
  runProjectDetect: commandMocks.runProjectDetect,
}));

vi.mock("./commands/node.js", () => ({
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

vi.mock("./commands/agent.js", () => ({
  runAgentStop: commandMocks.runAgentStop,
  runAgentStart: commandMocks.runAgentStart,
}));

vi.mock("./commands/agent-import.js", () => ({
  runAgentImport: commandMocks.runAgentImport,
}));

vi.mock("./commands/message.js", () => ({
  runMessageInbox: commandMocks.runMessageInbox,
  runMessageOutbox: commandMocks.runMessageOutbox,
  runMessageSend: commandMocks.runMessageSend,
  runMessageRead: commandMocks.runMessageRead,
  runMessageDelete: commandMocks.runMessageDelete,
  runAgentMailbox: commandMocks.runAgentMailbox,
}));

const originalArgv = process.argv;
const originalExit = process.exit;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

let importCounter = 0;

async function runBin(args: string[]) {
  process.argv = ["node", "bin.ts", ...args];
  importCounter += 1;
  await import(/* @vite-ignore */ `./bin.ts?test=${importCounter}`);
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

  it("shows help when no args are provided", async () => {
    await expect(runBin([])).rejects.toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

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

  it("routes mission list alias", async () => {
    await runBin(["mission", "ls"]);
    expect(commandMocks.runMissionList).toHaveBeenCalledWith(undefined);
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
    });
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
