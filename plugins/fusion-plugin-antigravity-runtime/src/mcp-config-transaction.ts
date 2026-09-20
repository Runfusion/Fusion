import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type McpEntryState = { name: string; enabled: boolean; command?: string; args?: string[]; env?: Record<string, string> };
type Owner = { pid: number; host: string; createdAt: number; lockId: string };
type EntryExpectation = { command: string; args: string[]; envKeys: string[] };
type Journal = { version: 2; transactionId: string; name: string; baseline: McpEntryState | null; owner: Owner; expectation: EntryExpectation; fingerprint: string };
export type McpCommand = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type McpLease = { name: string; dispose: () => Promise<void> };
const LOCK_TTL_MS = 30_000;
const LOCK_ATTEMPTS = 5;

/**
 * FNXC:AntigravityMcpTransaction 2026-09-20-19:17:
 * A live managed MCP entry owns the cross-process lock for its entire session.
 * A second session must not recover or replace a live entry because doing so
 * would remove the first session's approved tool bridge.
 *
 * FNXC:AntigravityMcpOwnership 2026-09-20-19:17:
 * Cleanup requires an exact non-secret command, argument, and environment-key
 * fingerprint from the documented list response. A replaced entry is preserved
 * and reported for manual remediation rather than being deleted by its name.
 */
function statePaths(root = join(homedir(), ".fusion", "antigravity-mcp")) {
  return { root, lock: join(root, "lock"), journal: join(root, "journal.json") };
}
function atomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
function readOwner(path: string): Owner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Owner;
    return typeof value.pid === "number" && typeof value.host === "string" && typeof value.createdAt === "number" && typeof value.lockId === "string" ? value : undefined;
  } catch { return undefined; }
}
function readJournal(path: string): Journal | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Journal;
    return value.version === 2 && typeof value.name === "string" && typeof value.fingerprint === "string" && Array.isArray(value.expectation?.args) && Array.isArray(value.expectation?.envKeys) && typeof value.expectation?.command === "string" && typeof value.owner?.lockId === "string" ? value : undefined;
  } catch { return undefined; }
}
function parseList(stdout: string): McpEntryState[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) return undefined;
    const entries: McpEntryState[] = [];
    for (const value of parsed.servers) {
      if (!value || typeof value !== "object") return undefined;
      const entry = value as Record<string, unknown>;
      if (typeof entry.name !== "string" || typeof entry.enabled !== "boolean") return undefined;
      const args = Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string") ? entry.args as string[] : undefined;
      const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) && Object.values(entry.env).every((item) => typeof item === "string") ? entry.env as Record<string, string> : undefined;
      entries.push({ name: entry.name, enabled: entry.enabled, command: typeof entry.command === "string" ? entry.command : undefined, args, env });
    }
    return entries;
  } catch { return undefined; }
}
function expectationFor(server: { command: string; args: string[]; env: Record<string, string> }): EntryExpectation {
  return { command: server.command, args: [...server.args], envKeys: Object.keys(server.env).sort() };
}
function fingerprint(command: string, args: string[], env: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({ command, args, env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)) })).digest("hex");
}
function entryFingerprint(entry: McpEntryState): string | undefined {
  if (!entry.command || !entry.args || !entry.env) return undefined;
  return fingerprint(entry.command, entry.args, entry.env);
}
function ownerIsLive(owner: Pick<Owner, "pid" | "host">): boolean {
  if (owner.host !== hostname() || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; } catch { return false; }
}
function ownershipError() {
  return Object.assign(new Error("Antigravity MCP entry ownership cannot be proven; configuration was preserved. Remove the named Fusion entry manually."), { code: "mcp-ownership-ambiguous" });
}
async function acquireLock(root: string): Promise<() => void> {
  const paths = statePaths(root);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const mine: Owner = { pid: process.pid, host: hostname(), createdAt: Date.now(), lockId: randomUUID() };
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(paths.lock, { mode: 0o700 });
      atomic(join(paths.lock, "owner.json"), mine);
      return () => {
        const owner = readOwner(join(paths.lock, "owner.json"));
        if (owner?.lockId === mine.lockId) rmSync(paths.lock, { recursive: true, force: true });
      };
    } catch {
      const owner = readOwner(join(paths.lock, "owner.json"));
      let age = 0;
      try { age = Date.now() - statSync(paths.lock).mtimeMs; } catch { age = 0; }
      if (age > LOCK_TTL_MS && owner && !ownerIsLive(owner)) {
        rmSync(paths.lock, { recursive: true, force: true });
        continue;
      }
      if (attempt === LOCK_ATTEMPTS - 1) throw Object.assign(new Error("Antigravity MCP configuration is busy; retry after the active session ends."), { code: "mcp-lock-unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10));
    }
  }
  throw Object.assign(new Error("Antigravity MCP configuration is busy; retry after the active session ends."), { code: "mcp-lock-unavailable" });
}

export class AntigravityMcpConfigTransaction {
  constructor(private readonly run: McpCommand, private readonly root?: string) {}
  private async list(): Promise<McpEntryState[]> {
    const result = await this.run(["mcp", "list"]);
    const entries = result.code === 0 ? parseList(result.stdout) : undefined;
    if (!entries) throw Object.assign(new Error("Antigravity MCP state could not be proven; inspect its MCP configuration before retrying."), { code: "mcp-state-ambiguous" });
    return entries;
  }
  async reconcile(): Promise<void> {
    const paths = statePaths(this.root);
    const release = await acquireLock(paths.root);
    try {
      const journal = readJournal(paths.journal);
      if (!journal) return;
      if (ownerIsLive(journal.owner)) throw Object.assign(new Error("Antigravity MCP configuration belongs to an active Fusion session."), { code: "mcp-session-active" });
      await this.restoreJournal(journal);
      rmSync(paths.journal, { force: true });
    } finally { release(); }
  }
  async stage(server: { command: string; args: string[]; env: Record<string, string> }): Promise<McpLease> {
    const paths = statePaths(this.root);
    const release = await acquireLock(paths.root);
    const name = `fusion-custom-tools-${randomUUID()}`;
    /**
     * FNXC:AntigravityMcpStagingRecovery 2026-09-20-19:37:
     * A failed add or enable can leave Fusion's entry installed before a lease
     * exists. Retain this journal in the staging scope so the held lock can
     * ownership-check and restore it before reporting the original failure.
     */
    let stagedJournal: Journal | undefined;
    try {
      const existing = readJournal(paths.journal);
      if (existing) {
        if (ownerIsLive(existing.owner)) throw Object.assign(new Error("Antigravity MCP configuration belongs to an active Fusion session."), { code: "mcp-session-active" });
        await this.restoreJournal(existing);
        rmSync(paths.journal, { force: true });
      }
      const entries = await this.list();
      if (entries.some((entry) => entry.name === name)) throw ownershipError();
      const expectation = expectationFor(server);
      stagedJournal = { version: 2, transactionId: randomUUID(), name, baseline: null, owner: { pid: process.pid, host: hostname(), createdAt: Date.now(), lockId: randomUUID() }, expectation, fingerprint: fingerprint(server.command, server.args, server.env) };
      atomic(paths.journal, stagedJournal);
      const envArgs = Object.entries(server.env).map(([key, value]) => `--env=${key}=${value}`);
      const add = await this.run(["mcp", "add", ...envArgs, name, server.command, ...server.args]);
      if (add.code !== 0) throw Object.assign(new Error("Antigravity rejected the temporary Fusion MCP entry."), { code: "mcp-add-failed" });
      const enabled = await this.run(["mcp", "enable", name]);
      if (enabled.code !== 0) throw Object.assign(new Error("Antigravity could not enable the temporary Fusion MCP entry."), { code: "mcp-enable-failed" });
    } catch (error) {
      let restoreError: unknown;
      try {
        if (stagedJournal) {
          await this.restoreJournal(stagedJournal);
          rmSync(paths.journal, { force: true });
        }
      } catch (caught) {
        restoreError = caught;
      } finally {
        release();
      }
      if (restoreError !== undefined) throw restoreError;
      throw error;
    }
    let disposed = false;
    return { name, dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        const journal = readJournal(paths.journal);
        if (!journal || journal.name !== name) throw ownershipError();
        await this.restoreJournal(journal);
        rmSync(paths.journal, { force: true });
      } finally { release(); }
    } };
  }
  private async restoreJournal(journal: Journal): Promise<void> {
    const current = await this.list();
    const entry = current.find((candidate) => candidate.name === journal.name);
    if (!entry) {
      if (journal.baseline) throw Object.assign(new Error("Antigravity MCP restoration is incomplete; restore the previous entry manually."), { code: "mcp-restore-failed" });
      return;
    }
    if (entryFingerprint(entry) !== journal.fingerprint) throw ownershipError();
    const remove = await this.run(["mcp", "remove", journal.name]);
    if (remove.code !== 0) throw Object.assign(new Error("Antigravity MCP cleanup failed; remove the named Fusion entry manually."), { code: "mcp-restore-failed" });
  }
}
