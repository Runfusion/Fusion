import { redactSecrets } from "../secrets/redact-secrets.js";
import { describe, expect, it } from "vitest";
import { externalSessionIngestionSchema, externalSessionId, externalSessionDigest, externalSessionFreshness } from "../external-sessions/contract.js";
import { externalSessionTurnSchema } from "../external-sessions/turn-contract.js";

const session = { provider: "other-runtime", nativeSessionId: "native-1", revision: 1, activity: "working", observedAt: "2026-09-17T00:00:00Z" };
const envelope = { schemaVersion: 1, streamId: "spool", sequence: 1, eventId: "event-1", collectorVersion: "1.0", session };

describe("external-session observation contract", () => {
  it("accepts any provider and canonicalizes timestamps/key order for retry digests", () => {
    const a = externalSessionIngestionSchema.parse(envelope);
    const b = externalSessionIngestionSchema.parse({ ...envelope, session: { ...Object.fromEntries(Object.entries(session).reverse()), observedAt: "2026-09-17T02:00:00+02:00" } });
    expect(a.session.observedAt).toBe("2026-09-17T00:00:00.000Z");
    expect(externalSessionDigest(a)).toBe(externalSessionDigest(b));
  });

  it("fingerprints redacted metadata even when replacement markers expand valid input text", () => {
    const input = externalSessionIngestionSchema.parse({ ...envelope, session: { ...session, title: "key=a ".repeat(80) } });
    const redacted = { ...input.session, title: redactSecrets(input.session.title!) };
    expect(redacted.title.length).toBeGreaterThan(512);
    const digest = externalSessionDigest(redacted);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const reordered = Object.fromEntries(Object.entries(redacted).reverse()) as typeof redacted;
    expect(externalSessionDigest(reordered)).toBe(digest);
    expect(externalSessionDigest({ ...input, session: reordered })).toBe(externalSessionDigest({ ...input, session: redacted }));
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

describe("external-session turn contract", () => {
  const turn = {
    nativeTurnId: "turn-1", revision: 1, ordinal: 0, state: "completed" as const,
    prompts: [{ at: "2026-09-17T02:00:00+02:00", text: "Fix the route\nwithout changing auth." }],
    response: "Implemented and verified.", startedAt: "2026-09-17T00:00:00Z",
    endedAt: "2026-09-17T00:00:03Z", durationMs: 3000, durationSource: "native" as const,
    toolCallCount: 4, fileChanges: [{ path: "src/route.ts", operation: "modify" as const,
      addedLines: 3, removedLines: 1, patchAvailable: true, patch: "@@ -1 +1 @@\n-old\n+new", truncated: false }],
  };

  it("normalizes timestamps while preserving prompts, duration provenance and historical patches", () => {
    const parsed = externalSessionTurnSchema.parse(turn);
    expect(parsed.prompts[0].at).toBe("2026-09-17T00:00:00.000Z");
    expect(parsed).toMatchObject({ durationMs: 3000, durationSource: "native", toolCallCount: 4,
      fileChanges: [{ path: "src/route.ts", addedLines: 3, removedLines: 1, patchAvailable: true }] });
  });

  it("keeps unknown metrics explicit and accepts unavailable historical patches", () => {
    const parsed = externalSessionTurnSchema.parse({ ...turn, response: null, startedAt: null, endedAt: null,
      durationMs: null, durationSource: null, toolCallCount: null,
      fileChanges: [{ path: "src/route.ts", operation: "modify", addedLines: null, removedLines: null,
        patchAvailable: false, truncated: false }] });
    expect(parsed.durationMs).toBeNull();
    expect(parsed.fileChanges[0].patch).toBeUndefined();
  });

  it("rejects inconsistent durations, time travel, forged extras and ambiguous patches", () => {
    expect(externalSessionTurnSchema.safeParse({ ...turn, durationSource: null }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, endedAt: "2026-09-16T23:59:59Z" }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, taskId: "FN-1" }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, fileChanges: [{ ...turn.fileChanges[0], patchAvailable: false }] }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, fileChanges: [{ ...turn.fileChanges[0], patch: undefined }] }).success).toBe(false);
  });

  it("bounds transcript, patch and collection sizes", () => {
    expect(externalSessionTurnSchema.safeParse({ ...turn, response: "x".repeat(1_048_577) }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, prompts: Array.from({ length: 33 }, () => turn.prompts[0]) }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, fileChanges: [{ ...turn.fileChanges[0], patch: "x".repeat(262_145) }] }).success).toBe(false);
    expect(externalSessionTurnSchema.safeParse({ ...turn, fileChanges: Array.from({ length: 129 }, () => turn.fileChanges[0]) }).success).toBe(false);
  });
});
