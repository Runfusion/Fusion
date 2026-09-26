import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { CliSessionStore } from "../../cli/cli-session-store.js";
import { ExternalSessionAttribution, fusionAdapterFor } from "../../external-sessions/attribution.js";
import { ExternalSessionStore } from "../../external-sessions/store.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:ExternalSessionAttribution 2026-09-24-07:05 (operator decision F4 = 1):
These tests exist to make double counting FAIL LOUDLY rather than show up as a total that is quietly too large.

Each case is a way the match could be wrong: a pre-spawn row whose native id is still null, a provider outside
the mapping, two CLI sessions claiming one native id, and the same external session resolved repeatedly. In
every one of them the honest answer is "not attributed", never a guess.
*/
const projectId = "attribution-test";

pgDescribe("external session attribution: provider + native id reconciliation", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_attribution", projectId });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  const attribution = () => new ExternalSessionAttribution(h.layer(), projectId);
  async function cliSession(input: { id: string; adapterId: string; taskId?: string | null; nativeSessionId?: string | null }) {
    const store = await CliSessionStore.create(h.layer(), projectId);
    store.createSession({ id: input.id, projectId, adapterId: input.adapterId, purpose: "execute",
      taskId: input.taskId ?? null, ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }) });
    await store.flush();
    return store;
  }

  it("attributes an external session to the Fusion task that produced it", async () => {
    await cliSession({ id: "cli-1", adapterId: "codex", taskId: "FN-1", nativeSessionId: "native-abc" });
    const resolved = await attribution().resolve([{ sessionId: "ext-1", provider: "codex", nativeSessionId: "native-abc" }]);
    expect(resolved.get("ext-1")).toEqual({ taskId: "FN-1", cliSessionId: "cli-1", ambiguous: false });
  });

  it("never matches a pre-spawn session whose native id is still unknown", async () => {
    // The row is created BEFORE spawn, so its native id is null until the runtime reports one.
    await cliSession({ id: "cli-2", adapterId: "codex", taskId: "FN-2", nativeSessionId: null });
    for (const nativeSessionId of [null, ""]) {
      const resolved = await attribution().resolve([{ sessionId: "ext-2", provider: "codex", nativeSessionId }]);
      expect(resolved.has("ext-2")).toBe(false);
    }
    // And a real external id must not match the null-id row either.
    expect((await attribution().resolve([{ sessionId: "ext-2", provider: "codex", nativeSessionId: "native-xyz" }])).has("ext-2")).toBe(false);
  });

  it("never matches across runtimes or an unmapped provider", async () => {
    await cliSession({ id: "cli-3", adapterId: "claude-code", taskId: "FN-3", nativeSessionId: "shared-id" });
    // Same native id string, different runtime id space: not the same run.
    expect((await attribution().resolve([{ sessionId: "ext-3", provider: "codex", nativeSessionId: "shared-id" }])).has("ext-3")).toBe(false);
    expect((await attribution().resolve([{ sessionId: "ext-3", provider: "claude", nativeSessionId: "shared-id" }])).get("ext-3"))
      .toMatchObject({ taskId: "FN-3" });
    // A provider outside the mapping is unattributed rather than guessed.
    expect(fusionAdapterFor("manual-test")).toBeNull();
    expect((await attribution().resolve([{ sessionId: "ext-3", provider: "manual-test", nativeSessionId: "shared-id" }])).has("ext-3")).toBe(false);
  });

  it("refuses to name a task when two CLI sessions claim one native id", async () => {
    await cliSession({ id: "cli-4a", adapterId: "codex", taskId: "FN-4A", nativeSessionId: "collide" });
    await cliSession({ id: "cli-4b", adapterId: "codex", taskId: "FN-4B", nativeSessionId: "collide" });
    const resolved = await attribution().resolve([{ sessionId: "ext-4", provider: "codex", nativeSessionId: "collide" }]);
    // Reported as ambiguous, attributed to neither: a coin flip here silently mis-credits a task's cost.
    expect(resolved.get("ext-4")).toEqual({ taskId: null, cliSessionId: null, ambiguous: true });
  });

  it("is stable across repeated resolution, so a re-import cannot double count", async () => {
    await cliSession({ id: "cli-5", adapterId: "codex", taskId: "FN-5", nativeSessionId: "native-5" });
    const batch = [
      { sessionId: "ext-5", provider: "codex", nativeSessionId: "native-5" },
      { sessionId: "ext-6", provider: "codex", nativeSessionId: "unmatched" },
      { sessionId: "ext-5", provider: "codex", nativeSessionId: "native-5" },
    ];
    const first = await attribution().resolve(batch);
    const second = await attribution().resolve(batch);
    // A duplicated input yields ONE entry, and the answer does not drift between runs.
    expect(first.size).toBe(1);
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(first.has("ext-6")).toBe(false);
  });

  it("does not attribute a CLI session belonging to another project", async () => {
    const other = await CliSessionStore.create(h.layer(), "other-project");
    other.createSession({ id: "cli-7", projectId: "other-project", adapterId: "codex", purpose: "execute",
      taskId: "FN-7", nativeSessionId: "native-7" });
    await other.flush();
    expect((await attribution().resolve([{ sessionId: "ext-7", provider: "codex", nativeSessionId: "native-7" }])).has("ext-7")).toBe(false);
    expect(() => new ExternalSessionAttribution(h.layer(), "other-project")).toThrow();
  });

  /* FNXC:ExternalSessionAttribution 2026-09-26-23:39: the task -> sessions direction must refuse exactly what
     the session -> task direction refuses, or task detail would show a run its own card calls unattributed. */
  let sequence = 0;
  async function externalSession(provider: string, nativeSessionId: string) {
    sequence += 1;
    const ack = await new ExternalSessionStore(h.layer(), { projectId, hostId: "host-1" }).ingest({ schemaVersion: 1,
      streamId: "spool", sequence, eventId: `event-${sequence}`, collectorVersion: "1.0",
      session: { provider, nativeSessionId, revision: 1, activity: "working", observedAt: "2026-09-26T00:00:00Z",
        title: "Session", projectPath: "/p" } });
    return ack.sessionId;
  }

  it("lists a task's proven sessions and nothing a card would refuse to attribute", async () => {
    await cliSession({ id: "cli-9", adapterId: "codex", taskId: "FN-9", nativeSessionId: "run-9" });
    await cliSession({ id: "cli-9b", adapterId: "claude-code", taskId: "FN-9", nativeSessionId: "run-9b" });
    await cliSession({ id: "cli-9c", adapterId: "codex", taskId: "FN-9", nativeSessionId: null });
    await cliSession({ id: "cli-9d", adapterId: "codex", taskId: "FN-9", nativeSessionId: "contested" });
    await cliSession({ id: "cli-10", adapterId: "codex", taskId: "FN-10", nativeSessionId: "contested" });
    const mine = await externalSession("codex", "run-9");
    const mineClaude = await externalSession("claude", "run-9b");
    await externalSession("claude", "run-9");          // same native id, other runtime: not this run
    await externalSession("manual-test", "run-9");     // unmapped provider: never attributed
    await externalSession("codex", "contested");       // two claimants: attributed to neither task
    await externalSession("codex", "unrelated");

    expect(await attribution().sessionIdsForTask("FN-9")).toEqual([mine, mineClaude].sort());
    expect(await attribution().sessionIdsForTask("FN-10")).toEqual([]);
    expect(await attribution().sessionIdsForTask("FN-missing")).toEqual([]);
  });

  it("makes no query at all when nothing could possibly match", async () => {
    expect((await attribution().resolve([])).size).toBe(0);
    expect((await attribution().resolve([{ sessionId: "ext-8", provider: "manual-test", nativeSessionId: null }])).size).toBe(0);
  });
});
