/**
 * FNXC:Identity 2026-08-09-03:04:
 * U6 — durable sessions (R11, R12, R29, KTD5).
 *
 * What these tests exist to catch:
 *   - DURABILITY (AE11). Everything session-shaped in the engine before this unit was in-memory only,
 *     so a daemon restart logged everyone out. The restart test therefore CLOSES the original
 *     connection pool and opens a new one against the same database, rather than reading back through
 *     the handle that wrote — reading through the writer would pass even for an in-memory map.
 *   - R12 rotation. A login that reuses the session id is a session-fixation hole, and a privilege
 *     change carried by a pre-change id lets an attacker holding that id inherit the new authority.
 *     Both assert the OLD id stops verifying, because a rotation that leaves the predecessor alive is
 *     not a rotation, it is a second credential.
 *   - R29's two policies. The agent assertions are the ones most likely to be broken by a
 *     well-intentioned "unify the expiry logic" change: an agent must survive an idle gap that would
 *     kill a human session and an absolute window that would too, and must instead be stopped by
 *     REVOCATION at its next tool call.
 *   - No raw session value at rest (KTD5): the token never appears in `central.actor_sessions`.
 */

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";
import { createConnectionSetFromUrl } from "../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../postgres/data-layer.js";
import type { ResolvedBackend } from "../postgres/backend-resolver.js";
import * as schema from "../postgres/schema/index.js";
import { createActor } from "../identity/actor-store.js";
import {
  AGENT_SESSION_POLICY,
  HUMAN_SESSION_POLICY,
  authorizeAgentToolCall,
  createSession,
  getSession,
  listSessionsForActor,
  renewAgentSession,
  revokeSession,
  rotateSessionForPrivilegeChange,
  startSession,
  verifySession,
} from "../identity/sessions.js";

const T0 = Date.parse("2026-08-09T03:04:00.000Z");
const HMAC_KEY = "identity-sessions-test-pepper";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

describe("identity sessions: lifetime policies (R29)", () => {
  it("gives humans an idle window long enough to survive the laptop-to-phone check-in pattern", () => {
    // A 30-minute idle timeout would tax the product's core loop; days is the right order.
    expect(HUMAN_SESSION_POLICY.idleMs).toBeGreaterThanOrEqual(DAY);
    expect(HUMAN_SESSION_POLICY.absoluteMs).toBeGreaterThan(HUMAN_SESSION_POLICY.idleMs);
    expect(HUMAN_SESSION_POLICY.rememberedDeviceIdleMs).toBeGreaterThan(HUMAN_SESSION_POLICY.idleMs);
    expect(HUMAN_SESSION_POLICY.rememberedDeviceAbsoluteMs).toBeGreaterThan(
      HUMAN_SESSION_POLICY.absoluteMs,
    );
  });

  it("gives agents NO idle timeout and a capped, run-bounded absolute lifetime", () => {
    expect(AGENT_SESSION_POLICY.idleMs).toBeNull();
    // The cap is what stops a caller manufacturing a non-expiring credential…
    expect(AGENT_SESSION_POLICY.maxLifetimeMs).toBeGreaterThan(AGENT_SESSION_POLICY.defaultRunMs);
    // …and it sits above the human absolute window because a long batch run legitimately outlives a
    // human session. That inequality is what AE25 is about.
    expect(AGENT_SESSION_POLICY.maxLifetimeMs).toBeGreaterThan(HUMAN_SESSION_POLICY.absoluteMs);
  });
});

pgDescribe("identity sessions (U6)", () => {
  async function withHarness(fn: (h: PgTestHarness) => Promise<void>): Promise<void> {
    const h = await createTaskStoreForTest({ prefix: "fusion_sessions" });
    try {
      await fn(h);
    } finally {
      await h.teardown();
    }
  }

  async function seedActor(h: PgTestHarness, id: string, kind: "human" | "agent"): Promise<void> {
    await createActor(h.layer, { id, kind, displayName: `Actor ${id}`, status: "active", now: at(0) });
  }

  /*
   * FNXC:Identity 2026-08-09-03:04:
   * Simulate a daemon restart honestly: close the pool that wrote the rows and open a NEW connection
   * set against the same database. Reading back through `h.layer` would prove nothing — an in-memory
   * session map would pass that too.
   */
  async function restartDaemon(h: PgTestHarness): Promise<{ layer: AsyncDataLayer; close: () => Promise<void> }> {
    await h.layer.close();
    const backend: ResolvedBackend = {
      mode: "external",
      runtimeUrl: h.testUrl,
      migrationUrl: h.testUrl,
      migrationUrlOverridden: false,
      directSessionUrl: h.testUrl,
      directSessionProvenance: "migration-override",
    };
    const connections = await createConnectionSetFromUrl(backend, { poolMax: 2, connectTimeoutSeconds: 5 });
    const layer = createAsyncDataLayer(connections);
    return { layer, close: () => layer.close() };
  }

  // ── Storage shape (KTD5) ───────────────────────────────────────────

  it("never persists the raw session value — only a lookup id and a hash", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const rows = await h.adminSql`SELECT * FROM central.actor_sessions`;
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(issued.token);
      // The secret segment must not appear either, in any column.
      const secret = issued.token.split("_")[2];
      expect(serialized).not.toContain(secret);
      // The lookup id is public and IS stored — that is what makes verification an indexed lookup.
      expect(serialized).toContain(issued.session.lookupId);
    });
  });

  // ── Verification basics ────────────────────────────────────────────

  it("verifies a freshly issued session and refuses a forged one", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const ok = await verifySession(h.layer, issued.token, { now: at(MINUTE), hmacKey: HMAC_KEY });
      expect(ok.ok).toBe(true);
      expect(ok.ok && ok.session.actorId).toBe("human-1");

      const forged = `fns_${issued.session.lookupId}_${"0".repeat(64)}`;
      const bad = await verifySession(h.layer, forged, { now: at(MINUTE), hmacKey: HMAC_KEY });
      expect(bad).toEqual({ ok: false, reason: "bad-secret" });

      expect(await verifySession(h.layer, "garbage", { now: at(MINUTE), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "malformed",
      });
      expect(
        await verifySession(h.layer, `fns_${"ab".repeat(12)}_${"cd".repeat(32)}`, {
          now: at(MINUTE),
          hmacKey: HMAC_KEY,
        }),
      ).toEqual({ ok: false, reason: "not-found" });
    });
  });

  // ── R12: rotation ──────────────────────────────────────────────────

  it("rotates the session id on login and refuses the predecessor", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const first = await startSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const second = await startSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        previousSessionId: first.session.id,
        now: at(HOUR),
        hmacKey: HMAC_KEY,
      });

      expect(second.session.id).not.toBe(first.session.id);
      expect(second.token).not.toBe(first.token);
      expect(second.session.lookupId).not.toBe(first.session.lookupId);
      // The planted/previous value must stop working — this is the fixation defence.
      expect(await verifySession(h.layer, first.token, { now: at(HOUR + MINUTE), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "revoked",
      });
      expect((await verifySession(h.layer, second.token, { now: at(HOUR + MINUTE), hmacKey: HMAC_KEY })).ok).toBe(
        true,
      );
    });
  });

  it("rotates the session id again on a privilege change, without extending the absolute lifetime", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const login = await startSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const rotated = await rotateSessionForPrivilegeChange(h.layer, login.session.id, {
        now: at(DAY),
        hmacKey: HMAC_KEY,
      });
      expect(rotated).not.toBeNull();
      expect(rotated!.session.id).not.toBe(login.session.id);
      expect(rotated!.token).not.toBe(login.token);
      // A role change is not a login: the absolute clock keeps running from the original login.
      expect(rotated!.session.absoluteExpiresAt).toBe(login.session.absoluteExpiresAt);

      expect(await verifySession(h.layer, login.token, { now: at(DAY + MINUTE), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "revoked",
      });
      expect((await verifySession(h.layer, rotated!.token, { now: at(DAY + MINUTE), hmacKey: HMAC_KEY })).ok).toBe(
        true,
      );

      // A revoked predecessor cannot be rotated again — that would undo the revocation.
      expect(
        await rotateSessionForPrivilegeChange(h.layer, login.session.id, { now: at(DAY + HOUR), hmacKey: HMAC_KEY }),
      ).toBeNull();
    });
  });

  // ── R12: human expiry ──────────────────────────────────────────────

  it("rejects a human session past its idle expiry", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      // A non-activity probe (`slideIdle: false`) must NOT count as activity, so the boundary below
      // is measured against the originally-issued window rather than one this test moved.
      const justInside = HUMAN_SESSION_POLICY.idleMs - MINUTE;
      expect(
        (await verifySession(h.layer, issued.token, { now: at(justInside), hmacKey: HMAC_KEY, slideIdle: false })).ok,
      ).toBe(true);

      expect(
        await verifySession(h.layer, issued.token, {
          now: at(HUMAN_SESSION_POLICY.idleMs + MINUTE),
          hmacKey: HMAC_KEY,
        }),
      ).toEqual({ ok: false, reason: "idle-expired" });
    });
  });

  it("slides the idle window on real activity, so a checked-in session does not idle out", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      // A check-in just inside the window …
      const checkIn = HUMAN_SESSION_POLICY.idleMs - HOUR;
      expect((await verifySession(h.layer, issued.token, { now: at(checkIn), hmacKey: HMAC_KEY })).ok).toBe(true);
      // … keeps the session alive past the point the ORIGINAL window would have expired.
      expect(
        (
          await verifySession(h.layer, issued.token, {
            now: at(HUMAN_SESSION_POLICY.idleMs + HOUR),
            hmacKey: HMAC_KEY,
          })
        ).ok,
      ).toBe(true);
    });
  });

  it("rejects a human session that is within idle but past its absolute expiry", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      // Keep the session active by verifying inside every idle window, right up to the absolute bound.
      let cursor = 0;
      while (cursor + HUMAN_SESSION_POLICY.idleMs - HOUR < HUMAN_SESSION_POLICY.absoluteMs) {
        cursor += HUMAN_SESSION_POLICY.idleMs - HOUR;
        const step = await verifySession(h.layer, issued.token, { now: at(cursor), hmacKey: HMAC_KEY });
        if (!step.ok) break;
      }

      const beforeAbsolute = HUMAN_SESSION_POLICY.absoluteMs - MINUTE;
      const stillLive = await verifySession(h.layer, issued.token, { now: at(beforeAbsolute), hmacKey: HMAC_KEY });
      expect(stillLive.ok).toBe(true);
      // Idle has been kept fresh, so the ONLY thing that can reject here is the absolute bound.
      expect(stillLive.ok && Date.parse(stillLive.session.idleExpiresAt!)).toBeGreaterThan(
        T0 + HUMAN_SESSION_POLICY.absoluteMs - MINUTE,
      );

      expect(
        await verifySession(h.layer, issued.token, {
          now: at(HUMAN_SESSION_POLICY.absoluteMs + MINUTE),
          hmacKey: HMAC_KEY,
        }),
      ).toEqual({ ok: false, reason: "absolute-expired" });
    });
  });

  it("clamps the sliding idle window so it can never outlive the absolute bound", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      // Stay active into the region where `now + idleWindow` would overshoot the absolute bound.
      const keepAlive = HUMAN_SESSION_POLICY.idleMs - HOUR;
      expect((await verifySession(h.layer, issued.token, { now: at(keepAlive), hmacKey: HMAC_KEY })).ok).toBe(true);

      const late = HUMAN_SESSION_POLICY.absoluteMs - 2 * HOUR;
      expect(late + HUMAN_SESSION_POLICY.idleMs).toBeGreaterThan(HUMAN_SESSION_POLICY.absoluteMs);
      const result = await verifySession(h.layer, issued.token, { now: at(late), hmacKey: HMAC_KEY });
      expect(result.ok).toBe(true);
      // Clamped exactly to the absolute bound — sliding must never extend past it.
      expect(result.ok && result.session.idleExpiresAt).toBe(issued.session.absoluteExpiresAt);
    });
  });

  it("lets a returning mobile session resume after an idle gap without re-entering a password", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const remembered = await startSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        rememberDevice: true,
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      const ordinary = await startSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      // A gap longer than the ordinary idle window: the phone resumes, the ordinary session does not.
      const gap = HUMAN_SESSION_POLICY.idleMs + DAY;
      const resumed = await verifySession(h.layer, remembered.token, { now: at(gap), hmacKey: HMAC_KEY });
      expect(resumed.ok).toBe(true);
      expect(await verifySession(h.layer, ordinary.token, { now: at(gap), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "idle-expired",
      });

      // And the remembered device keeps its long window after resuming, rather than being demoted.
      expect(resumed.ok && Date.parse(resumed.session.idleExpiresAt!) - (T0 + gap)).toBe(
        HUMAN_SESSION_POLICY.rememberedDeviceIdleMs,
      );
    });
  });

  // ── R29: agent sessions ────────────────────────────────────────────

  it("does not expire an agent session by idleness between heartbeats", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const issued = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      // R29: no idle timeout at all — not a long one, none.
      expect(issued.session.idleExpiresAt).toBeNull();

      // A gap far longer than a heartbeat interval, with no activity in between.
      const gap = AGENT_SESSION_POLICY.defaultRunMs - MINUTE;
      const result = await authorizeAgentToolCall(h.layer, issued.token, { now: at(gap), hmacKey: HMAC_KEY });
      expect(result.ok).toBe(true);
      // Authorizing a tool call must not have invented an idle window either.
      expect(result.ok && result.session.idleExpiresAt).toBeNull();
    });
  });

  it("keeps a long agent run alive past the window that would have killed a human session (AE25)", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      await seedActor(h, "human-1", "human");

      const runMs = HUMAN_SESSION_POLICY.absoluteMs + 2 * DAY;
      const agent = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        runDurationMs: runMs,
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      const human = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const past = HUMAN_SESSION_POLICY.absoluteMs + DAY;
      // The human absolute-timeout window has passed…
      expect(await verifySession(h.layer, human.token, { now: at(past), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "absolute-expired",
      });
      // …and the run continues under its own policy.
      expect((await authorizeAgentToolCall(h.layer, agent.token, { now: at(past), hmacKey: HMAC_KEY })).ok).toBe(true);
    });
  });

  it("caps an agent session's lifetime so a run duration cannot mint a non-expiring credential", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const issued = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        runDurationMs: 365 * DAY,
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      expect(Date.parse(issued.session.absoluteExpiresAt) - T0).toBe(AGENT_SESSION_POLICY.maxLifetimeMs);
      expect(
        await authorizeAgentToolCall(h.layer, issued.token, {
          now: at(AGENT_SESSION_POLICY.maxLifetimeMs + MINUTE),
          hmacKey: HMAC_KEY,
        }),
      ).toEqual({ ok: false, reason: "absolute-expired" });
    });
  });

  it("renews an agent session in-run, still bounded by the cap", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const issued = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        now: at(0),
        hmacKey: HMAC_KEY,
      });

      const renewed = await renewAgentSession(h.layer, issued.session.id, {
        runDurationMs: AGENT_SESSION_POLICY.defaultRunMs,
        now: at(AGENT_SESSION_POLICY.defaultRunMs - HOUR),
      });
      expect(renewed).not.toBeNull();
      expect(Date.parse(renewed!.absoluteExpiresAt)).toBeGreaterThan(
        Date.parse(issued.session.absoluteExpiresAt),
      );
      // Still alive an hour past the ORIGINAL bound — the run was not killed mid-tool-call.
      expect(
        (
          await authorizeAgentToolCall(h.layer, issued.token, {
            now: at(AGENT_SESSION_POLICY.defaultRunMs + HOUR),
            hmacKey: HMAC_KEY,
          })
        ).ok,
      ).toBe(true);

      // Renewal can never push past the cap.
      const capped = await renewAgentSession(h.layer, issued.session.id, {
        runDurationMs: 365 * DAY,
        now: at(HOUR),
      });
      expect(Date.parse(capped!.absoluteExpiresAt) - T0).toBe(AGENT_SESSION_POLICY.maxLifetimeMs);
    });
  });

  it("refuses a revoked agent session at its next tool call, not at expiry (R29)", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const issued = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        runDurationMs: 10 * DAY,
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      expect((await authorizeAgentToolCall(h.layer, issued.token, { now: at(HOUR), hmacKey: HMAC_KEY })).ok).toBe(
        true,
      );

      await revokeSession(h.layer, issued.session.id, at(HOUR + MINUTE));

      // The NEXT tool call fails — seconds later, and days before the absolute bound.
      expect(
        await authorizeAgentToolCall(h.layer, issued.token, { now: at(HOUR + 2 * MINUTE), hmacKey: HMAC_KEY }),
      ).toEqual({ ok: false, reason: "revoked" });
      // Prove the rejection was revocation, not expiry: the session was still far inside its window.
      const row = await getSession(h.layer, issued.session.id);
      expect(Date.parse(row!.absoluteExpiresAt)).toBeGreaterThan(T0 + 9 * DAY);

      // Renewal must not resurrect what an operator killed.
      expect(await renewAgentSession(h.layer, issued.session.id, { now: at(2 * HOUR) })).toBeNull();
    });
  });

  it("refuses renewal of an already-expired agent session", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const issued = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      const afterExpiry = Date.parse(issued.session.absoluteExpiresAt) + MINUTE;
      expect(
        await renewAgentSession(h.layer, issued.session.id, { now: at(afterExpiry - T0) }),
      ).toBeNull();
      const row = await getSession(h.layer, issued.session.id);
      expect(row?.absoluteExpiresAt).toBe(issued.session.absoluteExpiresAt);
    });
  });

  it("lists only live sessions for an actor", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "agent-1", "agent");
      const live = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      const revoked = await createSession(h.layer, {
        actorId: "agent-1",
        kind: "agent",
        now: at(MINUTE),
        hmacKey: HMAC_KEY,
      });
      await revokeSession(h.layer, revoked.session.id, at(2 * MINUTE));
      const listed = await listSessionsForActor(h.layer, "agent-1");
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(live.session.id);
    });
  });

  it("refuses a human session presented on the agent tool-call path", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      expect((await authorizeAgentToolCall(h.layer, issued.token, { now: at(MINUTE), hmacKey: HMAC_KEY })).ok).toBe(
        false,
      );
    });
  });

  // ── Revocation ─────────────────────────────────────────────────────

  it("rejects a revoked human session immediately", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      await revokeSession(h.layer, issued.session.id, at(MINUTE));
      expect(await verifySession(h.layer, issued.token, { now: at(2 * MINUTE), hmacKey: HMAC_KEY })).toEqual({
        ok: false,
        reason: "revoked",
      });
    });
  });

  it("keeps the first revocation timestamp when revoked twice", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      const issued = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      await revokeSession(h.layer, issued.session.id, at(MINUTE));
      await revokeSession(h.layer, issued.session.id, at(HOUR));
      const row = await getSession(h.layer, issued.session.id);
      expect(row!.revokedAt).toBe(at(MINUTE));
    });
  });

  // ── AE11: durability across a daemon restart ───────────────────────

  it("keeps sessions valid across a simulated daemon restart (AE11)", async () => {
    await withHarness(async (h) => {
      await seedActor(h, "human-1", "human");
      await seedActor(h, "human-2", "human");
      await seedActor(h, "agent-1", "agent");

      const a = await createSession(h.layer, { actorId: "human-1", kind: "human", now: at(0), hmacKey: HMAC_KEY });
      const b = await createSession(h.layer, {
        actorId: "human-2",
        kind: "human",
        rememberDevice: true,
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      const c = await createSession(h.layer, { actorId: "agent-1", kind: "agent", now: at(0), hmacKey: HMAC_KEY });
      const revoked = await createSession(h.layer, {
        actorId: "human-1",
        kind: "human",
        now: at(0),
        hmacKey: HMAC_KEY,
      });
      await revokeSession(h.layer, revoked.session.id, at(MINUTE));

      const restarted = await restartDaemon(h);
      try {
        for (const token of [a.token, b.token]) {
          expect((await verifySession(restarted.layer, token, { now: at(HOUR), hmacKey: HMAC_KEY })).ok).toBe(true);
        }
        expect(
          (await authorizeAgentToolCall(restarted.layer, c.token, { now: at(HOUR), hmacKey: HMAC_KEY })).ok,
        ).toBe(true);
        // Revocation survives the restart too — a restart must not resurrect a killed session.
        expect(await verifySession(restarted.layer, revoked.token, { now: at(HOUR), hmacKey: HMAC_KEY })).toEqual({
          ok: false,
          reason: "revoked",
        });

        // And the rows are genuinely the same rows, not re-created ones.
        const rows = await restarted.layer.db
          .select()
          .from(schema.central.actorSessions)
          .where(eq(schema.central.actorSessions.id, a.session.id));
        expect(rows).toHaveLength(1);
      } finally {
        await restarted.close();
      }
    });
  });
});
