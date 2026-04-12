import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Store for mock results - shared between callback and promisified paths
let mockResults: (string | Error)[] = [];
let resultIndex = 0;
const execCalls: [string, object | undefined][] = [];

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: typeof vi.fn = vi.fn((cmd: string, opts: object | undefined, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    // Track the call for assertion purposes
    execCalls.push([cmd, opts]);
    const callback = typeof opts === "function" ? opts : cb;
    // promisify path - callback is undefined
    if (callback === undefined) {
      return; // promisify.custom handles the Promise
    }
    try {
      const result = mockResults[resultIndex++] || "";
      const stdout = result instanceof Error ? "" : result.toString();
      callback(null, stdout, "");
    } catch (err) {
      callback(err as Error, "", "");
    }
  });
  // Mirror real child_process.exec: promisify resolves to { stdout, stderr }.
  execFn[promisify.custom] = (cmd: string, opts?: object) => {
    // Track the call for assertion purposes
    execCalls.push([cmd, opts]);
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const result = mockResults[resultIndex++] || "";
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve({ stdout: result.toString(), stderr: "" });
      }
    });
  };
  return { exec: execFn, execSync: vi.fn() };
});

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn(),
}));

import { createInterface } from "node:readline/promises";
import { resolveProject } from "../project-context.js";
import {
  isGitRepo,
  isValidBranchName,
  runGitStatus,
  runGitFetch,
  runGitPull,
  runGitPush,
} from "./git.js";

const mockCreateInterface = vi.mocked(createInterface);

// Helper to set up sequential mock results
function mockNextResult(result: string) {
  mockResults.push(result);
}

// Helper to check if exec was called with specific command
function wasExecCalled(cmd: string): boolean {
  return execCalls.some(([c]) => c === cmd);
}

// Helper to get last exec call
function getLastExecCall(): [string, object | undefined] | undefined {
  return execCalls[execCalls.length - 1];
}

describe("git commands", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResults = [];
    resultIndex = 0;
    execCalls.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj-1",
      projectName: "demo-project",
      projectPath: "/projects/demo",
      isRegistered: true,
      store: {} as ReturnType<typeof vi.fn>,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("core helpers work", async () => {
    mockNextResult(".git");
    expect(await isGitRepo()).toBe(true);
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("--bad")).toBe(false);
  });

  it("runGitStatus uses resolved project path", async () => {
    // isGitRepo, branch, commit, status, rev-list, dirty count
    mockNextResult(".git");
    mockNextResult("main\n");
    mockNextResult("a1b2c3d\n");
    mockNextResult(" M file.ts\n");
    mockNextResult("0\t0\n");
    mockNextResult(" M file.ts\n");

    await runGitStatus("demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(wasExecCalled("git status --porcelain")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/projects/demo" });
  });

  it("runGitStatus without project uses shared resolution flow", async () => {
    mockNextResult(".git");
    mockNextResult("main\n");
    mockNextResult("a1b2c3d\n");
    mockNextResult("");
    mockNextResult("0\t0\n");

    await runGitStatus();

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(wasExecCalled("git rev-parse --git-dir")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/projects/demo" });
  });

  it("runGitStatus without project falls back to current working directory when resolution fails", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/local/project");
    vi.mocked(resolveProject).mockRejectedValueOnce(new Error("No fusion project found"));
    mockNextResult(".git");
    mockNextResult("main\n");
    mockNextResult("a1b2c3d\n");
    mockNextResult("");
    mockNextResult("0\t0\n");

    await runGitStatus();

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(wasExecCalled("git rev-parse --git-dir")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/local/project" });
    cwdSpy.mockRestore();
  });

  it("runGitFetch uses resolved project path", async () => {
    mockNextResult(".git");
    mockNextResult("Fetch completed");

    await runGitFetch("origin", "demo-project");

    expect(wasExecCalled("git fetch origin")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/projects/demo" });
  });

  it("propagates project resolution errors for git commands", async () => {
    vi.mocked(resolveProject).mockRejectedValue(new Error("Project 'missing' not found. Run 'fn project list' to see registered projects."));

    await expect(runGitFetch("origin", "missing")).rejects.toThrow("Project 'missing' not found");
  });

  it("runGitPull uses resolved project path", async () => {
    const question = vi.fn().mockResolvedValue("y");
    mockCreateInterface.mockReturnValue({ question, close: vi.fn() } as ReturnType<typeof createInterface>);
    mockNextResult(".git");
    mockNextResult("main\n");
    mockNextResult("a1b2c3d\n");
    mockNextResult("");
    mockNextResult("0\t0\n");
    mockNextResult("Already up to date.");
    mockNextResult("Already up to date.");

    await runGitPull({ projectName: "demo-project" });

    expect(wasExecCalled("git pull")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/projects/demo" });
  });

  it("runGitPush uses resolved project path", async () => {
    const question = vi.fn().mockResolvedValue("y");
    mockCreateInterface.mockReturnValue({ question, close: vi.fn() } as ReturnType<typeof createInterface>);
    mockNextResult(".git");
    mockNextResult("main\n");
    mockNextResult("a1b2c3d\n");
    mockNextResult("");
    mockNextResult("0\t0\n");
    mockNextResult("");
    mockNextResult("");

    await runGitPush({ projectName: "demo-project" });

    expect(wasExecCalled("git push")).toBe(true);
    const lastCall = getLastExecCall();
    expect(lastCall).toBeDefined();
    expect(lastCall![1]).toMatchObject({ cwd: "/projects/demo" });
  });
});
