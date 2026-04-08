import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandMocks = vi.hoisted(() => ({
  runDashboard: vi.fn(),
  runDesktop: vi.fn(),
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
}));

vi.mock("./commands/dashboard.js", () => ({ runDashboard: commandMocks.runDashboard }));
vi.mock("./commands/desktop.js", () => ({ runDesktop: commandMocks.runDesktop }));
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

const originalArgv = process.argv;
const originalExit = process.exit;
const originalEnvProject = process.env.FN_PROJECT;

let importCounter = 0;

async function runBin(args: string[]) {
  process.argv = ["node", "bin.ts", ...args];
  importCounter += 1;
  if (importCounter === 1) {
    await import("./bin.ts?test=1");
  } else if (importCounter === 2) {
    await import("./bin.ts?test=2");
  } else if (importCounter === 3) {
    await import("./bin.ts?test=3");
  } else if (importCounter === 4) {
    await import("./bin.ts?test=4");
  } else if (importCounter === 5) {
    await import("./bin.ts?test=5");
  } else {
    await import("./bin.ts?test=6");
  }
}

describe("bin mission command integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FN_PROJECT;
    process.exit = vi.fn(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    if (originalEnvProject === undefined) {
      delete process.env.FN_PROJECT;
    } else {
      process.env.FN_PROJECT = originalEnvProject;
    }
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

  it("routes desktop flags to runDesktop", async () => {
    await runBin(["desktop", "--dev", "--paused", "--interactive"]);
    expect(commandMocks.runDesktop).toHaveBeenCalledWith({
      paused: true,
      dev: true,
      interactive: true,
    });
  });
});
