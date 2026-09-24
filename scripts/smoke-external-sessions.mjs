#!/usr/bin/env node
/**
 * FNXC:ExternalSessions 2026-09-17-22:56:
 * Manual acceptance smoke for the built CLI: own temporary home/project/embedded database,
 * random ephemeral HTTP port, paused automation and disposable collector credential.
 * It never uses an ambient database or existing Fusion instance. Only owned children are stopped.
 * process-supervisor-allowlist: standalone acceptance script with bounded attached child lifetimes.
 * port-4040-allowlist: rejects reserved ports; never probes or stops a live service.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createChildEnv, removeTempDir } from "./boot-smoke.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "packages/cli/bin.mjs");
const temporary = mkdtempSync(path.join(tmpdir(), "fusion-external-smoke-"));
const isolatedHome = path.join(temporary, "home");
const project = path.join(temporary, "project");
mkdirSync(isolatedHome); mkdirSync(project);
const children = new Set();
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
let output = "";

function launch(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const record = data => { output = (output + data.toString()).slice(-16_384); };
  child.stdout.on("data", record); child.stderr.on("data", record);
  child.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  child.done.catch(() => {});
  return child;
}

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for owned CLI process")), ms); })]);
  } finally { clearTimeout(timer); }
}

async function freePort() {
  const reserved = new Set([4040, ...(process.env.FUSION_RESERVED_PORTS ?? "").split(",").map(Number)]);
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer();
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(error => error ? reject(error) : resolve(value)); });
    });
    if (!reserved.has(port)) return port;
  }
  throw new Error("Could not obtain an unreserved ephemeral port");
}

async function main() {
  const env = { ...createChildEnv(process.env, isolatedHome),
    FUSION_DAEMON_TOKEN: undefined, FUSION_DASHBOARD_TOKEN: undefined,
    FUSION_EXTERNAL_SESSION_COLLECTORS: undefined,
  };
  const init = launch(["init", "--name", "external-session-smoke", "--path", project], env);
  assert.equal((await bounded(init.done, 180_000)).code, 0, "fn init failed");
  const { id: projectId } = JSON.parse(readFileSync(path.join(project, ".fusion/project.json"), "utf8"));
  assert.equal(typeof projectId, "string");
  const token = randomBytes(32).toString("hex");
  const hostId = "disposable-smoke-host";
  const port = await freePort();
  const serverEnv = { ...env,
    FUSION_EXTERNAL_SESSION_COLLECTORS: JSON.stringify([{ projectId, hostId, tokenSha256: createHash("sha256").update(token).digest("hex") }]),
  };
  const start = port => launch(["serve", "--host", "127.0.0.1", "--port", String(port), "--paused", "--no-auth"], serverEnv);
  let server = start(port);
  let base = `http://127.0.0.1:${port}`;
  const waitReady = async () => {
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline) {
      interrupted.signal.throwIfAborted();
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("Owned server exited before health was ready");
      try {
        const response = await fetch(`${base}/api/health`, { signal: globalThis.AbortSignal.timeout(1_000) });
        const health = await response.json();
        // FNXC:ExternalSessions 2026-09-17-23:01: The migration holding server returns HTTP 200; wait until the actual API is ready.
        ready = response.ok && health.holding !== true && (health.status === "ok" || health.status === "degraded");
      } catch { /* startup is asynchronous */ }
      if (ready) break;
      await delay(250, undefined, { signal: interrupted.signal });
    }
    assert.ok(ready, "Server did not become healthy");
  };
  const stop = async () => {
    server.kill("SIGTERM");
    const result = await bounded(server.done, 15_000);
    assert.ok(result.code === 0 || result.signal === "SIGTERM", "Unclean server shutdown");
  };
  await waitReady();
  console.log("PASS: isolated CLI boot and health");
  const post = async (operation, body, { authorized = true, scopedProject = projectId, extraHeaders = {} } = {}) => {
    interrupted.signal.throwIfAborted();
    const response = await fetch(`${base}/api/external-sessions/${operation}?projectId=${encodeURIComponent(scopedProject)}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      body: JSON.stringify(body), signal: globalThis.AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const heartbeat = { schemaVersion: 1, collectorVersion: "manual-smoke" };
  const beat = await post("heartbeat", heartbeat);
  assert.equal(beat.status, 200, `Heartbeat failed: ${JSON.stringify(beat.body)}`); assert.equal(beat.body.hostId, hostId);
  console.log("PASS: authenticated host heartbeat");
  const event = { schemaVersion: 1, collectorVersion: "manual-smoke", streamId: "smoke-spool", sequence: 1, eventId: "event-1",
    session: { provider: "codex", nativeSessionId: "session-1", revision: 1, activity: "working", observedAt: new Date().toISOString(), title: "Manual ingestion smoke",
      feedback: { generation: "smoke-generation", expiresAt: new Date(Date.now() + 3600000).toISOString() },
      usageComplete: true, usage: [{ model: "gpt-5.6-sol", inputTokens: 1000, cachedInputTokens: 500, cacheWriteTokens: 0, cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: 20, fast: false, longContext: false }], recentActivity: [{ kind: "prompt", at: new Date().toISOString(), text: "Disposable native activity" }] } };
  const first = await post("ingest", event);
  assert.equal(first.status, 200); assert.equal(first.body.applied, true); assert.equal(first.body.acknowledgedSequence, 1);
  const replay = await post("ingest", event);
  assert.equal(replay.status, 200); assert.equal(replay.body.applied, false); assert.equal(replay.body.sessionId, first.body.sessionId);
  console.log("PASS: ingestion and response-loss replay");
  // FNXC:RemoteAgents 2026-09-17-23:19: Exercise the real project-bound dashboard reader, including exact host filters and the receipt-free presentation contract.
  const read = async endpoint => {
    const response = await fetch(`${base}/api/external-sessions${endpoint}${endpoint.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}`,
      { signal: globalThis.AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const page = await read(`?hostId=${hostId}&provider=codex&limit=1`);
  assert.equal(page.sessions.length, 1); assert.equal(page.nextCursor, null);
  assert.equal(page.sessions[0].id, first.body.sessionId); assert.equal(page.sessions[0].collectorConnected, true);
  assert.equal(Object.hasOwn(page.sessions[0], "observationDigest"), false);
  assert.equal((await read("?hostId=other-host")).sessions.length, 0);
  assert.equal((await read(`/${first.body.sessionId}`)).session.id, first.body.sessionId);
  console.log("PASS: project-scoped remote session list/detail and host filters");
  const commandId = randomUUID();
  const feedbackBody = { commandId, generation: "smoke-generation", text: "Disposable feedback acceptance" };
  assert.equal((await post(`${first.body.sessionId}/feedback`, feedbackBody, { authorized: false, extraHeaders: { Origin: "https://other-origin.test" } })).status, 403);
  const queued = await post(`${first.body.sessionId}/feedback`, feedbackBody, { authorized: false });
  assert.equal(queued.status, 200); assert.equal(queued.body.status, "queued");
  assert.deepEqual((await post(`${first.body.sessionId}/feedback`, feedbackBody, { authorized: false })).body, queued.body);
  const identity = { sessionId: first.body.sessionId, generation: "smoke-generation" };
  assert.equal((await post("feedback-claim", identity, { authorized: false })).status, 401);
  const claim = await post("feedback-claim", identity); assert.equal(claim.body.command.commandId, commandId);
  assert.equal((await post("feedback-claim", identity)).body.command, null);
  assert.equal((await post("feedback-ack", { ...identity, commandId, status: "delivered" })).body.acknowledged, true);
  const cost = await read(`/${first.body.sessionId}/cost`);
  assert.equal(cost.usage[0].input, 500); assert.equal(cost.usage[0].output, 100); assert.equal(typeof cost.estimatedUsd, "number");
  console.log("PASS: standalone feedback queue/claim/ack, double-click fencing and disjoint token costs");
  const gap = await post("ingest", { ...event, sequence: 3, eventId: "event-3" });
  assert.equal(gap.status, 409); assert.equal(gap.body.error, "sequence-gap"); assert.equal(gap.body.acknowledgedSequence, 1);
  const changed = await post("ingest", { ...event, eventId: "changed" });
  assert.equal(changed.status, 409); assert.equal(changed.body.error, "sequence-conflict");
  const completed = { ...event, sequence: 2, eventId: "event-2", session: { ...event.session, revision: 2, activity: "completed" } };
  const next = await post("ingest", completed);
  assert.equal(next.status, 200); assert.equal(next.body.applied, true); assert.equal(next.body.sessionId, first.body.sessionId);
  console.log("PASS: gap/conflict rejection and subsequent revision");
  assert.equal((await post("heartbeat", heartbeat, { authorized: false })).status, 401);
  assert.equal((await post("heartbeat", heartbeat, { scopedProject: "other-project" })).status, 403);
  assert.equal((await post("heartbeat", heartbeat, { extraHeaders: { Origin: "https://browser.test" } })).status, 403);
  console.log("PASS: missing credential, project mismatch and browser rejection");
  await stop();
  const restartPort = await freePort();
  server = start(restartPort);
  base = `http://127.0.0.1:${restartPort}`;
  await waitReady();
  const recovered = await post("ingest", completed);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.applied, false);
  assert.equal(recovered.body.sessionId, first.body.sessionId); assert.equal(recovered.body.acknowledgedSequence, 2);
  assert.equal((await read(`/${first.body.sessionId}`)).session.observation.activity, "completed");
  assert.equal((await read(`/${first.body.sessionId}/feedback`)).feedback[0].status, "delivered");
  console.log("PASS: durable acknowledgement and replay after server restart");
  await stop();
  console.log("PASS: clean shutdown");
}

try { await main(); }
catch (error) { console.error(`FAIL: ${error.message}\n${output}`); process.exitCode = 1; }
finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try { await bounded(child.done, 15_000); } catch { child.kill("SIGKILL"); await child.done.catch(() => {}); }
    }
  }
  removeTempDir(temporary);
}

if (!process.exitCode) console.log("PASS: disposable state removed");
