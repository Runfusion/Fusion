import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commandMocks = vi.hoisted(() => ({
  runDashboard: vi.fn(),
  runDashboardSupervised: vi.fn(),
  runServe: vi.fn(),
  runDaemon: vi.fn(),
  runDesktop: vi.fn(),
  runInit: vi.fn(),
  runOnboard: vi.fn(),

  runTaskCreate: vi.fn(),
  runTaskList: vi.fn(),
  runTaskMove: vi.fn(),
  runTaskMerge: vi.fn(),
  runTaskUpdate: vi.fn(),
  runTaskDeps: vi.fn(),
  runTaskLog: vi.fn(),
  runTaskLogs: vi.fn(),
  runTaskShow: vi.fn(),
  runTaskAttach: vi.fn(),
  runTaskPause: vi.fn(),
  runTaskUnpause: vi.fn(),
  runTaskImportFromGitHub: vi.fn(),
  runTaskImportGitHubInteractive: vi.fn(),
  runTaskImportFromGitLab: vi.fn(),
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

  runPrCreate: vi.fn(),
  runPrShow: vi.fn(),
  runPrList: vi.fn(),
  runPrRespond: vi.fn(),
  runPrApprove: vi.fn(),
  runPrRetry: vi.fn(),
  runPrMerge: vi.fn(),
  runPrClose: vi.fn(),
  runPrAutomerge: vi.fn(),
  runPrAutomergeCleanup: vi.fn(),

  runSettingsShow: vi.fn(),
  runSettingsSet: vi.fn(),
  runSettingsExport: vi.fn(),
  runSettingsImport: vi.fn(),
  runOrgExport: vi.fn(),
  runOrgImport: vi.fn(),

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
  runMissionLinkGoal: vi.fn(),
  runMissionUnlinkGoal: vi.fn(),
  runMissionGoals: vi.fn(),
  runGoalsList: vi.fn(),
  runGoalsCreate: vi.fn(),
  runGoalsArchive: vi.fn(),
  runGoalsCitations: vi.fn(),

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
  runPluginNew: vi.fn(),
  runPluginDev: vi.fn(),

  runResearchCreate: vi.fn(),
  runResearchList: vi.fn(),
  runResearchShow: vi.fn(),
  runResearchExport: vi.fn(),
  runResearchCancel: vi.fn(),
  runResearchRetry: vi.fn(),
}));

const onboardEnv = vi.hoisted(() => ({
  centralDbPath: "/tmp/fusion-central.db",
}));

const ttyState = vi.hoisted(() => ({
  isTTYAvailable: true,
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    getDefaultCentralDbPath: vi.fn(() => onboardEnv.centralDbPath),
  };
});

vi.mock("../commands/dashboard-tui/index.js", () => ({
  isTTYAvailable: vi.fn(() => ttyState.isTTYAvailable),
}));

vi.mock("../commands/onboard.js", () => ({ runOnboard: commandMocks.runOnboard }));

vi.mock("../commands/dashboard.js", () => ({
  runDashboard: commandMocks.runDashboard,
  // FNXC:CliTests 2026-07-13-08:20: bin.ts now imports shouldSuperviseDashboard (supervision is the default) and runDashboardSupervised from dashboard.js; mock must surface both so the no-args dashboard launch test reaches runDashboard instead of failing on an undefined import.
  shouldSuperviseDashboard: vi.fn(() => false),
  runDashboardSupervised: commandMocks.runDashboardSupervised,
}));
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
  runTaskDeps: commandMocks.runTaskDeps,
  runTaskLog: commandMocks.runTaskLog,
  runTaskLogs: commandMocks.runTaskLogs,
  runTaskShow: commandMocks.runTaskShow,
  runTaskAttach: commandMocks.runTaskAttach,
  runTaskPause: commandMocks.runTaskPause,
  runTaskUnpause: commandMocks.runTaskUnpause,
  runTaskImportFromGitHub: commandMocks.runTaskImportFromGitHub,
  runTaskImportGitHubInteractive: commandMocks.runTaskImportGitHubInteractive,
  runTaskImportFromGitLab: commandMocks.runTaskImportFromGitLab,
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
}));

vi.mock("../commands/pr.js", () => ({
  runPrCreate: commandMocks.runPrCreate,
  runPrShow: commandMocks.runPrShow,
  runPrList: commandMocks.runPrList,
  runPrRespond: commandMocks.runPrRespond,
  runPrApprove: commandMocks.runPrApprove,
  runPrRetry: commandMocks.runPrRetry,
  runPrMerge: commandMocks.runPrMerge,
  runPrClose: commandMocks.runPrClose,
  runPrAutomerge: commandMocks.runPrAutomerge,
  runPrAutomergeCleanup: commandMocks.runPrAutomergeCleanup,
}));

vi.mock("../commands/settings.js", () => ({
  runSettingsShow: commandMocks.runSettingsShow,
  runSettingsSet: commandMocks.runSettingsSet,
}));
vi.mock("../commands/settings-export.js", () => ({ runSettingsExport: commandMocks.runSettingsExport }));
vi.mock("../commands/settings-import.js", () => ({ runSettingsImport: commandMocks.runSettingsImport }));
vi.mock("../commands/org-export.js", () => ({ runOrgExport: commandMocks.runOrgExport }));
vi.mock("../commands/org-import.js", () => ({ runOrgImport: commandMocks.runOrgImport }));

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
  runMissionLinkGoal: commandMocks.runMissionLinkGoal,
  runMissionUnlinkGoal: commandMocks.runMissionUnlinkGoal,
  runMissionGoals: commandMocks.runMissionGoals,
}));

vi.mock("../commands/goals.js", () => ({
  runGoalsList: commandMocks.runGoalsList,
  runGoalsCreate: commandMocks.runGoalsCreate,
  runGoalsArchive: commandMocks.runGoalsArchive,
  runGoalsCitations: commandMocks.runGoalsCitations,
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
  runPluginNew: commandMocks.runPluginNew,
}));

vi.mock("../commands/plugin-dev.js", () => ({
  runPluginDev: commandMocks.runPluginDev,
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
const originalSkipOnboardingEnv = process.env.FUSION_SKIP_ONBOARDING;

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
    delete process.env.FUSION_SKIP_ONBOARDING;
    ttyState.isTTYAvailable = true;
    onboardEnv.centralDbPath = join(mkdtempSync(join(tmpdir(), "fn-bin-onboard-")), "fusion-central.db");
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

    if (originalSkipOnboardingEnv === undefined) {
      delete process.env.FUSION_SKIP_ONBOARDING;
    } else {
      process.env.FUSION_SKIP_ONBOARDING = originalSkipOnboardingEnv;
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

  it("routes organization export and import flags", async () => {
    await runBin(["org-export", "bundle.json", "-P", "demo"]);
    await runBin(["org-import", "bundle.json", "--dry-run", "--collision-mode", "suffix", "-P", "demo"]);

    expect(commandMocks.runOrgExport).toHaveBeenCalledWith("bundle.json", { project: "demo" });
    expect(commandMocks.runOrgImport).toHaveBeenCalledWith("bundle.json", { project: "demo", dryRun: true, collisionMode: "suffix" });
  });

  it("rejects an invalid organization import collision mode", async () => {
    await expect(runBin(["org-import", "bundle.json", "--collision-mode", "replace"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("--collision-mode must be skip or suffix");
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


  it("routes task dependency replacement", async () => {
    await runBin(["task", "deps", "replace", "FN-155", "FN-191", "FN-195", "--project", "atlas-notes"]);
    expect(commandMocks.runTaskDeps).toHaveBeenCalledWith(
      "replace",
      "FN-155",
      ["FN-191", "FN-195"],
      "atlas-notes",
    );
  });

  it("routes task dependency add", async () => {
    await runBin(["task", "deps", "add", "FN-155", "FN-191", "--project", "atlas-notes"]);
    expect(commandMocks.runTaskDeps).toHaveBeenCalledWith(
      "add",
      "FN-155",
      ["FN-191"],
      "atlas-notes",
    );
  });

  it("errors for task deps missing operation", async () => {
    await expect(runBin(["task", "deps"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Usage: fn task deps add <id> <dependency>");
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
    await runBin(["message", "inbox", "--user", "dashboard", "-P", "demo"]);
    await runBin(["message", "outbox", "-P", "demo"]);

    expect(commandMocks.runMessageSend).toHaveBeenCalledWith("agent-7", "hello there", "demo");
    expect(commandMocks.runMessageRead).toHaveBeenCalledWith("msg-1", "demo");
    expect(commandMocks.runMessageDelete).toHaveBeenCalledWith("msg-1", "demo");
    // FN-8424: `fn message inbox` gained `--user <cli|dashboard>`; without the
    // flag routing passes undefined so runMessageInbox defaults to the CLI mailbox.
    expect(commandMocks.runMessageInbox).toHaveBeenNthCalledWith(1, "demo", undefined);
    expect(commandMocks.runMessageInbox).toHaveBeenNthCalledWith(2, "demo", "dashboard");
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

  it("routes plugin new with scope and output flags", async () => {
    await runBin(["plugin", "new", "hello-plugin", "--scope", "acme", "--output", "./hello-plugin"]);
    expect(commandMocks.runPluginNew).toHaveBeenCalledWith("hello-plugin", {
      scope: "acme",
      output: "./hello-plugin",
    });
  });

  it("routes plugin dev with once and ai-scan flags", async () => {
    await runBin(["plugin", "dev", "./hello-plugin", "--once", "--ai-scan", "-P", "demo"]);
    expect(commandMocks.runPluginDev).toHaveBeenCalledWith("./hello-plugin", {
      once: true,
      aiScan: true,
      projectName: "demo",
    });
  });

  it("shows plugin help guidance with install/add alias on unknown plugin subcommand", async () => {
    await expect(runBin(["plugin", "oops"])).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: plugin oops");
    expect(logSpy).toHaveBeenCalledWith(
      "Try: fn plugin list | install | add (alias for install) | uninstall | enable | disable | available | settings | rescan | setup-status | setup | create | new | dev | publish",
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
      undefined,
      [],
    );
  });

  it("routes mission create with repeated --goal flags", async () => {
    await runBin([
      "mission",
      "create",
      "Test Mission",
      "Detailed",
      "mission",
      "description",
      "--goal",
      "G-001",
      "--goal",
      "G-002",
      "--base-branch",
      "feature/mission",
    ]);

    expect(commandMocks.runMissionCreate).toHaveBeenCalledWith(
      "Test Mission",
      "Detailed mission description",
      undefined,
      "feature/mission",
      ["G-001", "G-002"],
    );
  });

  it("surfaces non-zero exit from mission create goal validation failures", async () => {
    commandMocks.runMissionCreate.mockImplementationOnce(() => {
      throw new Error("process.exit:1");
    });

    await expect(runBin(["mission", "create", "Test Mission", "--goal", "G-ARCHIVED"])).rejects.toThrow("process.exit:1");
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

  it("routes mission goals", async () => {
    await runBin(["mission", "goals", "M-001"]);
    expect(commandMocks.runMissionGoals).toHaveBeenCalledWith("M-001", undefined);
  });

  it("routes mission link-goal", async () => {
    await runBin(["mission", "link-goal", "M-001", "G-001", "--project", "demo"]);
    expect(commandMocks.runMissionLinkGoal).toHaveBeenCalledWith("M-001", "G-001", "demo");
  });

  it("routes mission unlink-goal", async () => {
    await runBin(["mission", "unlink-goal", "M-001", "G-001"]);
    expect(commandMocks.runMissionUnlinkGoal).toHaveBeenCalledWith("M-001", "G-001", undefined);
  });

  it("routes goals list with default status", async () => {
    await runBin(["goals", "list"]);
    expect(commandMocks.runGoalsList).toHaveBeenCalledWith(undefined, { status: "active" });
  });

  it("routes goals ls with explicit status", async () => {
    await runBin(["goals", "ls", "--status", "all"]);
    expect(commandMocks.runGoalsList).toHaveBeenCalledWith(undefined, { status: "all" });
  });

  it("routes goals list with project and archived status", async () => {
    await runBin(["goals", "list", "--status", "archived", "--project", "demo"]);
    expect(commandMocks.runGoalsList).toHaveBeenCalledWith("demo", { status: "archived" });
  });

  it("routes goals create with multi-word description", async () => {
    await runBin(["goals", "create", "Title", "Long", "desc"]);
    expect(commandMocks.runGoalsCreate).toHaveBeenCalledWith("Title", "Long desc", undefined);
  });

  it("routes goals archive with project", async () => {
    await runBin(["goals", "archive", "G-001", "--project", "demo"]);
    expect(commandMocks.runGoalsArchive).toHaveBeenCalledWith("G-001", "demo");
  });

  it("exits on unknown goals subcommand", async () => {
    await expect(runBin(["goals", "bogus"])).rejects.toThrow("process.exit:1");
  });

  it("auto-launches onboarding for interactive commands when central DB is missing", async () => {
    await runBin(["task", "list"]);

    expect(commandMocks.runOnboard).toHaveBeenCalledTimes(1);
    expect(commandMocks.runTaskList).toHaveBeenCalledTimes(1);
  });

  it("does not auto-launch onboarding for non-TTY invocations", async () => {
    ttyState.isTTYAvailable = false;

    await runBin(["task", "list"]);

    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
    expect(commandMocks.runTaskList).toHaveBeenCalledTimes(1);
  });

  it.each(["serve", "daemon"])("skips auto-launch for %s command", async (command) => {
    await runBin([command]);

    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
  });

  it("does not auto-launch when central DB and project DB already exist", async () => {
    const projectDbPath = join(process.cwd(), ".fusion", "fusion.db");
    mkdirSync(join(process.cwd(), ".fusion"), { recursive: true });
    writeFileSync(onboardEnv.centralDbPath, "db");
    writeFileSync(projectDbPath, "project-db");

    await runBin(["task", "list"]);

    expect(existsSync(onboardEnv.centralDbPath)).toBe(true);
    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
  });

  it("honors --skip-onboarding flag", async () => {
    await runBin(["task", "list", "--skip-onboarding"]);

    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
    expect(commandMocks.runTaskList).toHaveBeenCalledTimes(1);
  });

  it("honors FUSION_SKIP_ONBOARDING env var", async () => {
    process.env.FUSION_SKIP_ONBOARDING = "1";

    await runBin(["task", "list"]);

    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
  });

  it("passes --force to explicit onboard command and keeps marker semantics covered in onboard.test.ts", async () => {
    await runBin(["onboard", "--force"]);

    expect(commandMocks.runOnboard).toHaveBeenCalledWith({ force: true });
  });

  it("auto-launch decision keys on central-DB existence, not the completion marker (single-fire is covered in onboard.test.ts)", async () => {
    writeFileSync(onboardEnv.centralDbPath, "db");

    await runBin(["task", "list"]);

    // shouldAutoLaunchOnboarding does not consult the completion marker; runOnboard covers marker single-fire behavior.
    expect(commandMocks.runOnboard).not.toHaveBeenCalled();
    expect(commandMocks.runTaskList).toHaveBeenCalledTimes(1);
  });

  it("routes daemon command with all flags", async () => {
    await runBin(["daemon", "--port", "5055", "--host", "127.0.0.1", "--token", "fn_abc123", "--paused", "--token-only"]);

    expect(commandMocks.runDaemon).toHaveBeenCalledWith({
      port: 5055,
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
      args: ["pr", "create", "FN-001", "--draft"],
      expected: { draft: true, ai: true },
    },
  ])("routes PR creation variants %#", async ({ args, expected }) => {
    await runBin(args);
    expect(commandMocks.runPrCreate).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining(expected),
      undefined,
    );
  });

  it("no longer dispatches the retired `fn task pr-create`", async () => {
    await expect(runBin(["task", "pr-create", "FN-001"])).rejects.toThrow("process.exit:1");
    expect(commandMocks.runPrCreate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown subcommand: task pr-create"));
  });

  it("errors on missing pr subcommand", async () => {
    await expect(runBin(["pr"]))
      .rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Unknown subcommand: pr ");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Try: fn pr create <task-id>"));
  });

  it("routes pr automerge-cleanup flags", async () => {
    await runBin(["pr", "automerge-cleanup", "--apply", "--json", "--project", "ops"]);
    expect(commandMocks.runPrAutomergeCleanup).toHaveBeenCalledWith(
      { apply: true, json: true },
      "ops",
    );
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
      noAuth: false,
    });
  });

  it.each([
    {
      args: ["desktop", "--no-auth"],
      expected: { paused: false, dev: false, interactive: false, noAuth: true },
    },
    {
      args: ["desktop", "--no-auth", "--paused"],
      expected: { paused: true, dev: false, interactive: false, noAuth: true },
    },
    {
      args: ["desktop", "--dev", "--no-auth"],
      expected: { paused: false, dev: true, interactive: false, noAuth: true },
    },
  ])("routes desktop --no-auth variants %#", async ({ args, expected }) => {
    await runBin(args);
    expect(commandMocks.runDesktop).toHaveBeenCalledWith(expected);
  });
});
