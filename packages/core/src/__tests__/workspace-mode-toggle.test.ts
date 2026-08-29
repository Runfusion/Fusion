import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  applyWorkspaceModeToggle,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  setWorkspaceModeInConfig,
  removeWorkspaceConfig,
  detectWorkspaceRepos,
  withWorkspaceModeLock,
  type WorkspaceModeToggleOps,
} from "../git/git-repository.js";

const exec = promisify(execFile);
const cleanup: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "fusion-workspace-toggle-")); cleanup.push(path); return path; };
async function repo(root: string, name: string): Promise<void> {
  const cwd = join(root, name); mkdirSync(cwd, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd });
  await exec("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(join(cwd, "README.md"), name); await exec("git", ["add", "."], { cwd }); await exec("git", ["commit", "-m", "init"], { cwd });
}
const configMode = (root: string) => JSON.parse(readFileSync(join(root, ".fusion", "config.json"), "utf8")).settings.workspaceMode;
const realOps: WorkspaceModeToggleOps = { loadWorkspaceConfig, saveWorkspaceConfig, setWorkspaceModeInConfig, removeWorkspaceConfig, detectWorkspaceRepos };
afterEach(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("applyWorkspaceModeToggle", () => {
  it("creates and removes both disk signals without clobbering unrelated config", async () => {
    const root = temp(); await repo(root, "a"); await repo(root, "b");
    expect((await applyWorkspaceModeToggle(root, true)).enabled).toBe(true);
    expect((await loadWorkspaceConfig(root))?.repos).toEqual(["a", "b"]); expect(configMode(root)).toBe(true);
    writeFileSync(join(root, ".fusion", "config.json"), JSON.stringify({ keep: 1, settings: { workspaceMode: true } }));
    expect((await applyWorkspaceModeToggle(root, false)).enabled).toBe(false);
    expect(existsSync(join(root, ".fusion", "workspace.json"))).toBe(false); expect(configMode(root)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".fusion", "config.json"), "utf8")).keep).toBe(1);
  });

  it("preserves a curated config and refuses roots without sub-repositories", async () => {
    const root = temp(); await repo(root, "a"); await repo(root, "b");
    await saveWorkspaceConfig(root, { repos: ["b"] }); const before = readFileSync(join(root, ".fusion", "workspace.json"), "utf8");
    await applyWorkspaceModeToggle(root, true); expect(readFileSync(join(root, ".fusion", "workspace.json"), "utf8")).toBe(before);
    const empty = temp(); const result = await applyWorkspaceModeToggle(empty, true);
    expect(result).toMatchObject({ enabled: false, repos: [], failureReason: "no-sub-repositories" });
    expect(existsSync(join(empty, ".fusion", "workspace.json"))).toBe(false);
  });

  it("reconciles failed writes to observed workspace.json", async () => {
    const root = temp(); await repo(root, "a");
    const failedEnable = await applyWorkspaceModeToggle(root, true, { ops: { ...realOps, saveWorkspaceConfig: async () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } } });
    expect(failedEnable.enabled).toBe(false); expect(configMode(root)).toBe(false);
    await applyWorkspaceModeToggle(root, true); const failedDisable = await applyWorkspaceModeToggle(root, false, { ops: { ...realOps, removeWorkspaceConfig: async () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } } });
    expect(failedDisable.enabled).toBe(true); expect(configMode(root)).toBe(true);
  });

  it("serializes same-root callers and releases after a throwing body", async () => {
    const root = temp(); const order: string[] = []; let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const startedGate = new Promise<void>((done) => { started = done; });
    const ops = { ...realOps, loadWorkspaceConfig: async (path: string) => { order.push("load"); started(); await gate; return realOps.loadWorkspaceConfig(path); } };
    const first = applyWorkspaceModeToggle(root, false, { ops });
    await startedGate; const second = applyWorkspaceModeToggle(root, false, { ops });
    expect(order).toEqual(["load"]); release(); await Promise.all([first, second]);
    await expect(withWorkspaceModeLock(root, async () => { throw new Error("expected"); })).rejects.toThrow("expected");
    await expect(withWorkspaceModeLock(root, async () => "free")).resolves.toBe("free");
  });
});
