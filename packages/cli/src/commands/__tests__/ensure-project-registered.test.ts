import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCwdProjectRegistered } from "../ensure-project-registered.js";

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("ensureCwdProjectRegistered", () => {
  it("returns existing registered project without writing files", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();
    const existing = await central.registerProject({
      name: "existing-project",
      path: cwd,
      isolationMode: "in-process",
    });

    const registerSpy = vi.spyOn(central, "registerProject");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result?.id).toBe(existing.id);
    expect(existsSync(join(cwd, ".fusion"))).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    await central.close();
  });

  it("auto-registers unregistered project when enabled", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    const registerSpy = vi.spyOn(central, "registerProject");
    const updateSpy = vi.spyOn(central, "updateProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).not.toBeNull();
    expect(existsSync(join(cwd, ".fusion"))).toBe(true);
    expect(existsSync(join(cwd, ".fusion", "fusion.db"))).toBe(true);
    expect(statSync(join(cwd, ".fusion", "fusion.db")).size).toBe(0);
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: cwd,
        isolationMode: "in-process",
      }),
    );
    expect(updateSpy).toHaveBeenCalledWith(expect.any(String), { status: "active" });

    await central.close();
  });

  it("returns null and does not write when autoRegister is false", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    const registerSpy = vi.spyOn(central, "registerProject");

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "daemon",
      autoRegister: false,
    });

    expect(result).toBeNull();
    expect(existsSync(join(cwd, ".fusion"))).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();

    await central.close();
  });

  it("returns null and logs error when registration throws", async () => {
    const globalDir = makeTempDir("fn-4266-global-");
    const cwd = makeTempDir("fn-4266-project-");

    const central = new CentralCore(globalDir);
    await central.init();

    vi.spyOn(central, "registerProject").mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureCwdProjectRegistered({
      cwd,
      central,
      logPrefix: "serve",
      autoRegister: true,
    });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[serve] Failed to auto-register current project: boom"),
    );

    await central.close();
  });
});
