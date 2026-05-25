// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

const mocked = vi.hoisted(() => ({ runGitCommand: vi.fn() }));
vi.mock("../routes/resolve-diff-base.js", () => ({ runGitCommand: mocked.runGitCommand }));

class MockStore extends EventEmitter {
  recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  getRootDir(): string { return "/repo"; }
  getFusionDir(): string { return "/repo/.fusion"; }
  getSettings = vi.fn().mockResolvedValue({ integrationBranch: "trunk" });
  getSettingsFast = vi.fn().mockResolvedValue({ integrationBranch: "trunk" });
  getDatabase() { return { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), all: vi.fn().mockReturnValue([]), get: vi.fn() }) }; }
}

type Scripted = string | Error;
function gitScript(map: Record<string, Scripted>): string[] {
  const calls: string[] = [];
  mocked.runGitCommand.mockImplementation(async (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const hit = Object.entries(map).find(([prefix]) => key.startsWith(prefix));
    if (!hit) throw new Error(`missing mock for ${key}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1] as string;
  });
  return calls;
}

function createApp(getActiveMergeTaskId: () => string | null = () => null, store = new MockStore()) {
  const app = createServer(store as any, { selfHealingManager: { rootDir: "/repo", reconcileInReviewBranchRebind: vi.fn(), getActiveMergeTaskId } } as any);
  return { app, store };
}

const baseMap = {
  "rev-parse --git-dir": ".git\n",
  "remote get-url origin": "git@github.com:org/repo.git\n",
  "rev-parse --verify --quiet refs/remotes/origin/trunk": "ok\n",
  "rev-parse refs/heads/trunk": "localsha\n",
  "rev-parse refs/remotes/origin/trunk": "remotesha\n",
};

describe("merge-advance push-origin routes", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("GET push-status covers not-a-git-repo and no-remote/no-upstream/not-ahead", async () => {
    let calls = gitScript({ "rev-parse --git-dir": new Error("not a git repository") });
    let { app } = createApp();
    let res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body.disabledReason).toBe("not-a-git-repo");

    calls = gitScript({ "rev-parse --git-dir": ".git\n", "remote get-url origin": new Error("missing origin") });
    ({ app } = createApp());
    res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body.disabledReason).toBe("no-remote");

    calls = gitScript({ "rev-parse --git-dir": ".git\n", "remote get-url origin": "x", "rev-parse --verify --quiet refs/remotes/origin/trunk": new Error("missing upstream") });
    ({ app } = createApp());
    res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body.disabledReason).toBe("no-upstream");

    calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "1\t0\n" });
    ({ app } = createApp());
    res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body).toMatchObject({ integrationBranch: "trunk", aheadCount: 0, disabledReason: "not-ahead", canPush: false });
    expect(calls.some((c) => c.includes("main"))).toBe(false);
  });

  it("GET push-status reports ahead and merge-locked", async () => {
    gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t3\n" });
    let { app } = createApp();
    let res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body).toMatchObject({ aheadCount: 3, canPush: true });

    gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n" });
    ({ app } = createApp(() => "FN-1"));
    res = await request(app, "GET", "/api/projects/default/merge-advance/push-status");
    expect(res.body).toMatchObject({ disabledReason: "merge-locked", canPush: false });
  });

  it("POST happy path pushes without force and audits", async () => {
    const calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t3\n", "push origin refs/heads/trunk:refs/heads/trunk": "", "rev-parse refs/remotes/origin/trunk": "localsha\n" });
    const { app, store } = createApp();
    const res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body).toMatchObject({ ok: true, outcome: "ok", remoteSha: "localsha" });
    expect(calls.some((c) => /\b--force\b(?!-with-lease)/.test(c))).toBe(false);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin", metadata: expect.objectContaining({ forceWithLease: false }) }));
  });

  it("POST refusal paths return not-ahead/no-remote/no-upstream/sha-mismatch/merge-locked and never push", async () => {
    let calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "1\t0\n" });
    let { app, store } = createApp();
    let res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body.outcome).toBe("not-ahead");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin" }));
    expect(calls.some((c) => c.startsWith("push "))).toBe(false);

    calls = gitScript({ "rev-parse --git-dir": ".git\n", "remote get-url origin": new Error("no remote") });
    ({ app, store } = createApp());
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body.outcome).toBe("no-remote");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin" }));

    calls = gitScript({ "rev-parse --git-dir": ".git\n", "remote get-url origin": "x", "rev-parse --verify --quiet refs/remotes/origin/trunk": new Error("missing upstream") });
    ({ app, store } = createApp());
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body.outcome).toBe("no-upstream");

    calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n" });
    ({ app, store } = createApp(() => "FN-LOCK"));
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body.outcome).toBe("merge-locked");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin" }));

    calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n" });
    ({ app, store } = createApp());
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({ expectedLocalSha: "other" }), { "content-type": "application/json" });
    expect(res.body.outcome).toBe("sha-mismatch");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin" }));
    expect(calls.some((c) => c.startsWith("push "))).toBe(false);
  });

  it("POST handles non-fast-forward and force-with-lease stale info", async () => {
    let calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n", "push origin refs/heads/trunk:refs/heads/trunk": Object.assign(new Error("rejected"), { stderr: "[rejected] non-fast-forward" }) });
    let { app, store } = createApp();
    let res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body).toMatchObject({ ok: false, outcome: "rejected-non-ff" });
    expect(res.body.message).toBeDefined();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin" }));

    calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n", "push --force-with-lease=refs/heads/trunk:localsha origin refs/heads/trunk:refs/heads/trunk": Object.assign(new Error("stale"), { stderr: "stale info" }) });
    ({ app, store } = createApp());
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({ forceWithLease: true }), { "content-type": "application/json" });
    expect(calls.some((c) => c.includes("--force-with-lease=refs/heads/trunk:localsha"))).toBe(true);
    expect(res.body).toMatchObject({ outcome: "rejected-non-ff" });
    expect(res.body.message).toContain("Remote moved");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "push:origin", metadata: expect.objectContaining({ forceWithLease: true }) }));
  });

  it("POST force-with-lease success and TOCTOU merge lock", async () => {
    let calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n", "push --force-with-lease=refs/heads/trunk:localsha origin refs/heads/trunk:refs/heads/trunk": "", "rev-parse refs/remotes/origin/trunk": "localsha\n" });
    let { app } = createApp();
    let res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({ forceWithLease: true }), { "content-type": "application/json" });
    expect(res.body).toMatchObject({ ok: true, outcome: "ok" });
    expect(calls.some((c) => c.startsWith("push --force-with-lease="))).toBe(true);

    let mergeCheckCount = 0;
    calls = gitScript({ ...baseMap, "rev-list --left-right --count refs/remotes/origin/trunk...refs/heads/trunk": "0\t2\n" });
    ({ app } = createApp(() => {
      mergeCheckCount += 1;
      return mergeCheckCount >= 2 ? "FN-TOCTOU" : null;
    }));
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.body).toMatchObject({ ok: false, outcome: "merge-locked" });
    expect(calls.some((c) => c.startsWith("push "))).toBe(false);
  });

  it("POST validates request body types", async () => {
    const { app } = createApp();
    let res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({ forceWithLease: "yes" }), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    res = await request(app, "POST", "/api/projects/default/merge-advance/push-origin", JSON.stringify({ expectedLocalSha: 123 }), { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });
});
