import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeMcpConfig, evaluateQuarantine, reconcileCursorWorktree, stageCursorMcpLease } from "../cursor-mcp-config.js";

const dirs: string[] = [];
const dir = () => { const value = mkdtempSync(join(tmpdir(), "fusion-cursor-mcp-")); dirs.push(value); return value; };
afterEach(() => dirs.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })));

describe("Cursor MCP lease config", () => {
  it("quarantines an initially malformed operator config without changing its bytes", async () => {
    const root = dir(); const cursor = join(root, ".cursor"); mkdirSync(cursor);
    const config = join(cursor, "mcp.json"); const malformed = '{"mcpServers":{"operator":'; writeFileSync(config, malformed);
    await expect(stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: "bridge", args: [] } })).rejects.toMatchObject({ code: "bridge-start-failed" });
    expect(readFileSync(config, "utf8")).toBe(malformed);
    const state = JSON.parse(readFileSync(join(cursor, ".fusion-mcp-state.json"), "utf8"));
    expect(state.baseline.parsable).toBe(false);
    expect(state.quarantine.raw).toBe(malformed);
  });

  it("restores a pre-existing operator config after the final lease", async () => {
    const root = dir(); const cursor = join(root, ".cursor");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(cursor));
    const config = join(cursor, "mcp.json"); const baseline = '{\n  "mcpServers": { "operator": { "command": "echo" } }\n}\n'; writeFileSync(config, baseline);
    const lease = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: process.execPath, args: ["bridge"] } });
    expect(readFileSync(config, "utf8")).toContain("fusion-custom-tools-one");
    await lease.dispose(); expect(readFileSync(config, "utf8")).toBe(baseline);
  });
  it("preserves a parsable operator edit made before disposal", async () => {
    const root = dir(); const cursor = join(root, ".cursor"); mkdirSync(cursor);
    const config = join(cursor, "mcp.json"); writeFileSync(config, '{"mcpServers":{"operator":{"command":"before"}}}\n');
    const lease = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: "bridge", args: [] } });
    const edited = '{\n  "mcpServers": { "operator-edit": { "command": "after" }, "fusion-custom-tools-one": { "command": "stale" } }\n}\n';
    writeFileSync(config, edited);
    await lease.dispose();
    const after = readFileSync(config, "utf8"); expect(after).toContain("operator-edit"); expect(after).not.toContain("fusion-custom-tools-one");
  });
  it("removes a Fusion-created cursor directory after releasing its nested lock", async () => {
    const root = dir(); const lease = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: "bridge", args: [] } });
    await lease.dispose();
    expect(() => readFileSync(join(root, ".cursor"))).toThrow();
  });
  it("reclaims a stale owner-recorded lock before staging", async () => {
    const root = dir(); const cursor = join(root, ".cursor"); mkdirSync(join(cursor, ".fusion-mcp.lock"), { recursive: true });
    writeFileSync(join(cursor, ".fusion-mcp.lock", "owner.json"), JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: Date.now() - 31_000 }));
    const lease = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: "bridge", args: [] } });
    await lease.dispose();
  });
  it("does not steal a freshly-created lock before its owner is published", async () => {
    const root = dir(); const cursor = join(root, ".cursor"); const lock = join(cursor, ".fusion-mcp.lock");
    mkdirSync(lock, { recursive: true });
    // Model a second process between atomic mkdir and its subsequent owner.json publication.
    const contender = stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-contender", serverEntry: { command: "bridge", args: [] } });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const owner = { pid: process.pid, hostname: hostname(), acquiredAt: Date.now() };
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
    await expect(contender).rejects.toMatchObject({ code: "bridge-start-failed" });
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(owner);
    expect(() => readFileSync(join(cursor, "mcp.json"), "utf8")).toThrow();
  });
  it("keeps peer entries from the durable manifest", async () => {
    const root = dir(); const first = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-one", serverEntry: { command: "one", args: ["a"] } });
    const second = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-two", serverEntry: { command: "two", args: ["b"], env: { TOKEN: "x" } } });
    await first.dispose(); const raw = readFileSync(join(root, ".cursor", "mcp.json"), "utf8"); expect(raw).toContain('"two"'); expect(raw).not.toContain('"one"'); await second.dispose();
  });
  it("reaps a dead same-host lease before its heartbeat TTL", async () => {
    const root = dir(); const first = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-dead", serverEntry: { command: "dead", args: [] } });
    const statePath = join(root, ".cursor", ".fusion-mcp-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.leases["fusion-custom-tools-dead"].pid = 999_999_999;
    state.leases["fusion-custom-tools-dead"].hostname = hostname();
    state.leases["fusion-custom-tools-dead"].heartbeatAt = Date.now();
    writeFileSync(statePath, JSON.stringify(state));
    const second = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-live", serverEntry: { command: "live", args: [] } });
    const config = readFileSync(join(root, ".cursor", "mcp.json"), "utf8");
    expect(config).not.toContain("fusion-custom-tools-dead");
    expect(config).toContain("fusion-custom-tools-live");
    await first.dispose(); await second.dispose();
  });
  it("recomposes after reconciliation reaps a dead peer while another lease remains", async () => {
    const root = dir();
    const first = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-dead", serverEntry: { command: "dead", args: [] } });
    const second = await stageCursorMcpLease({ worktreePath: root, serverKey: "fusion-custom-tools-live", serverEntry: { command: "live", args: [] } });
    const statePath = join(root, ".cursor", ".fusion-mcp-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.leases["fusion-custom-tools-dead"].pid = 999_999_999;
    state.leases["fusion-custom-tools-dead"].hostname = hostname();
    writeFileSync(statePath, JSON.stringify(state));
    await reconcileCursorWorktree(root);
    const config = readFileSync(join(root, ".cursor", "mcp.json"), "utf8");
    expect(config).not.toContain("fusion-custom-tools-dead");
    expect(config).toContain("fusion-custom-tools-live");
    await first.dispose(); await second.dispose();
  });
  it("does not create a cursor directory when reconciliation has no residue", async () => { const root = dir(); await reconcileCursorWorktree(root); expect(() => readFileSync(join(root, ".cursor"))).toThrow(); });
  it("composes current operator content without Fusion keys", () => { const raw = composeMcpConfig({ currentRaw: '{"mcpServers":{"operator":{"command":"x"},"fusion-custom-tools-old":{"command":"old"}}}', leases: { "fusion-custom-tools-new": { serverEntry: { command: "new", args: [] } } } }); expect(raw).toContain("operator"); expect(raw).toContain("fusion-custom-tools-new"); expect(raw).not.toContain("fusion-custom-tools-old"); });
  it("re-pins a changed unparsable quarantine instead of clearing it", () => { expect(evaluateQuarantine({ currentRaw: "{broken", quarantine: { raw: "{older", fusionKeys: [], observedAt: "now" } })).toBe("repin"); });
});
