import { describe, expect, it } from "vitest";
import { externalSessionIngestionSchema, externalSessionId, externalSessionDigest, externalSessionFreshness } from "../external-sessions/contract.js";

const session = { provider: "other-runtime", nativeSessionId: "native-1", revision: 1, activity: "working", observedAt: "2026-09-17T00:00:00Z" };
const envelope = { schemaVersion: 1, streamId: "spool", sequence: 1, eventId: "event-1", collectorVersion: "1.0", session };

describe("external-session observation contract", () => {
  it("accepts any provider and canonicalizes timestamps/key order for retry digests", () => {
    const a = externalSessionIngestionSchema.parse(envelope);
    const b = externalSessionIngestionSchema.parse({ ...envelope, session: { ...Object.fromEntries(Object.entries(session).reverse()), observedAt: "2026-09-17T02:00:00+02:00" } });
    expect(a.session.observedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(externalSessionDigest(a)).toBe(externalSessionDigest(b));
  });

  it("binds identity to project/host/provider/native id, independently of title/path", () => {
    const principal = { projectId: "project", hostId: "host" };
    const observation = externalSessionIngestionSchema.parse(envelope).session;
    const id = externalSessionId(principal, observation);
    expect(externalSessionId(principal, externalSessionIngestionSchema.parse({ ...envelope, session: { ...session, title: "renamed", projectPath: "/new/path" } }).session)).toBe(id);
    for (const changed of [{ ...principal, projectId: "other" }, { ...principal, hostId: "other" }]) {
      expect(externalSessionId(changed, observation)).not.toBe(id);
    }
    expect(externalSessionId(principal, { ...observation, provider: "other" })).not.toBe(id);
    expect(externalSessionId(principal, { ...observation, nativeSessionId: "other" })).not.toBe(id);
    expect(externalSessionId({ projectId: "a", hostId: "b:c" }, observation)).not.toBe(externalSessionId({ projectId: "a:b", hostId: "c" }, observation));
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe stream/revision counter %s", value => {
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, sequence: value }).success).toBe(false);
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, session: { ...session, revision: value } }).success).toBe(false);
  });

  it("rejects task/control authority, extra fields, malformed ids and oversized metadata", () => {
    for (const extra of [{ hostId: "forged" }, { projectId: "forged" }, { taskId: "FN-1" }, { capabilities: ["stop"] }, { runtimeHandle: "pid-1" }]) {
      expect(externalSessionIngestionSchema.safeParse({ ...envelope, session: { ...session, ...extra } }).success).toBe(false);
    }
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, schemaVersion: 2 }).success).toBe(false);
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, streamId: "bad\u0000id" }).success).toBe(false);
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, session: { ...session, title: "x".repeat(513) } }).success).toBe(false);
    expect(externalSessionIngestionSchema.safeParse({ ...envelope, session: { ...session, observedAt: "not-a-date" } }).success).toBe(false);
  });

  it("keeps collector connectivity independent from terminal/ongoing activity", () => {
    const observation = externalSessionIngestionSchema.parse(envelope).session;
    const now = Date.parse("2026-09-17T00:02:00Z");
    expect(externalSessionFreshness(observation, "2026-09-17T00:01:59Z", now)).toEqual({ collectorConnected: true, activityStale: true });
    expect(externalSessionFreshness({ ...observation, activity: "completed" }, null, now)).toEqual({ collectorConnected: false, activityStale: false });
  });
});
