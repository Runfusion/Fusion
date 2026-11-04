/**
 * RUFU-462 Step 3/4: a process whose heap ceiling nobody chose must say so through channels an operator
 * already reads — the runtime log and the Mailbox — at most once a day on the Mailbox lane, and must never
 * become a lifecycle dependency of the boot that is trying to report it.
 *
 * The shape under test is the one `retention-pressure-notice.ts` established (one-shot system notice,
 * UTC-day idempotency bucket, numbers/enum in metadata with prose confined to `content`), because a second
 * delivery convention for a second memory notice is how the two notices end up disagreeing.
 *
 * The motivating condition is the no-flag boot: no `--max-old-space-size` in execArgv and none in
 * NODE_OPTIONS, which is exactly how the host that filed this card ran through 28 supervisor restarts.
 * Several tests below construct precisely that state through the injectable resolver seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_USER_ID, type MessageCreateInput } from "@fusion/core";
import {
  buildHeapCeilingLogContext,
  buildHeapCeilingLogMessage,
  buildHeapCeilingNoticeContent,
  buildHeapCeilingNoticeIdempotencyKey,
  HEAP_CEILING_MUTATION_TYPE,
  HEAP_CEILING_NOTICE_BUCKET_MS,
  notifyDefaultHeapCeiling,
  reportHeapCeilingAtBoot,
  resetHeapCeilingBootReportForTesting,
  type HeapCeilingMailbox,
} from "../heap-ceiling-notice.js";
import {
  MAX_OLD_SPACE_FLAG,
  resolveHeapCeiling,
  type HeapCeiling,
} from "../lib/heap-ceiling.js";

/** A ~4.09 GiB ceiling — the value V8 picked on the reporting host, in bytes. */
const V8_DEFAULT_BYTES = Math.round(4.09 * 1024 * 1024 * 1024);

/**
 * The symptom state: neither launch site declares a ceiling, so the classification is `v8-default`.
 * Going through the real resolver (rather than a literal object) means these tests assert what the boot
 * path actually produces, not what a fixture claims.
 */
function defaultCeiling(over: Partial<HeapCeiling> = {}): HeapCeiling {
  return {
    ...resolveHeapCeiling({ execArgv: [], env: {}, heapSizeLimitBytes: V8_DEFAULT_BYTES }),
    ...over,
  };
}

function declaredCeiling(over: Partial<HeapCeiling> = {}): HeapCeiling {
  return {
    ...resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=16384` },
      heapSizeLimitBytes: Math.round(16.09 * 1024 * 1024 * 1024),
    }),
    ...over,
  };
}

function fakeLogger() {
  const warn = vi.fn();
  const info = vi.fn();
  return { warn, info, scope: "test", error: vi.fn(), child: () => ({ warn, info }) };
}

function fakeMailbox(inserted = true) {
  const sendMessageOnce = vi.fn(async () => ({ inserted }));
  return { sendMessageOnce, mailbox: { sendMessageOnce } as unknown as HeapCeilingMailbox };
}

describe("heap ceiling notice — log lane", () => {
  it("warns with the byte ceiling, the fact that it is the V8 default, and the runbook pointer", () => {
    const message = buildHeapCeilingLogMessage(defaultCeiling());

    expect(message).toContain("V8 default");
    expect(message).toContain("4.09 GiB");
    expect(message).toContain(MAX_OLD_SPACE_FLAG);
    expect(message).toContain("dashboard-heap-growth-runbook.md");
    // The honest bound: naming the number must not read as a promise that the product will fix it.
    expect(message).toContain("never sets its own ceiling");
  });

  it("reports a declared ceiling without the default warning", () => {
    const message = buildHeapCeilingLogMessage(declaredCeiling());

    expect(message).toContain("16.09 GiB");
    expect(message).not.toContain("V8 default");
  });

  it("never echoes launch-environment content beyond the fixed flag name", () => {
    // A host can legitimately carry a connection string or credential argument in NODE_OPTIONS; the
    // warning is generated in-process and must not quote it.
    const noisy = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: `${MAX_OLD_SPACE_FLAG}=8192 --require=/opt/secret-loader.js?token=abc` },
      heapSizeLimitBytes: Math.round(8.09 * 1024 * 1024 * 1024),
    });

    const message = buildHeapCeilingLogMessage(noisy);
    const content = buildHeapCeilingNoticeContent(noisy);
    const context = JSON.stringify(buildHeapCeilingLogContext(noisy));

    for (const rendered of [message, content, context]) {
      expect(rendered).not.toContain("secret-loader");
      expect(rendered).not.toContain("token=abc");
      expect(rendered).not.toContain("8192");
    }
  });

  it("keeps the log context to numbers, one fixed enum, and one boolean", () => {
    const context = buildHeapCeilingLogContext(defaultCeiling());

    expect(Object.keys(context).sort()).toEqual(["heapLimitBytes", "isV8Default", "source"]);
    expect(typeof context.heapLimitBytes).toBe("number");
    expect(typeof context.isV8Default).toBe("boolean");
    expect(["execArgv", "NODE_OPTIONS", "v8-default"]).toContain(context.source);
  });
});

describe("heap ceiling notice — Mailbox content", () => {
  it("names the ceiling, both places a host can set it, the runbook, and the no-intervention bound", () => {
    const content = buildHeapCeilingNoticeContent(defaultCeiling());

    expect(content).toContain("4.09 GiB");
    expect(content).toContain("execArgv");
    expect(content).toContain("NODE_OPTIONS");
    expect(content).toContain("docs/solutions/performance/dashboard-heap-growth-runbook.md");
    expect(content).toContain("This is a warning, not an intervention");
    expect(content).toContain("never sets, raises, or defaults");
    // The failure it replaces: the restart count being the only evidence.
    expect(content).toContain("/api/health");
  });
});

describe("heap ceiling notice — rate limiting", () => {
  it("collapses every boot inside one UTC day to a single idempotency key", async () => {
    const morning = Date.UTC(2026, 9, 1, 0, 5, 0);
    const evening = Date.UTC(2026, 9, 1, 23, 55, 0);
    expect(buildHeapCeilingNoticeIdempotencyKey(morning)).toBe(buildHeapCeilingNoticeIdempotencyKey(evening));
    expect(buildHeapCeilingNoticeIdempotencyKey(morning)).toMatch(/^heap-ceiling:v8-default:\d+$/);

    const { mailbox, sendMessageOnce } = fakeMailbox();
    await notifyDefaultHeapCeiling(defaultCeiling(), { mailbox, nowMs: morning });
    await notifyDefaultHeapCeiling(defaultCeiling(), { mailbox, nowMs: evening });

    const keys = sendMessageOnce.mock.calls.map((call) => (call as [MessageCreateInput, string])[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("re-announces on the next UTC day so a standing condition is never silenced forever", () => {
    const day1 = Date.UTC(2026, 9, 1, 12, 0, 0);
    const day2 = day1 + HEAP_CEILING_NOTICE_BUCKET_MS;
    expect(buildHeapCeilingNoticeIdempotencyKey(day2)).not.toBe(buildHeapCeilingNoticeIdempotencyKey(day1));
  });
});

describe("heap ceiling notice — Mailbox delivery", () => {
  it("writes a system notice to the operator inbox with prose confined to content", async () => {
    const { mailbox, sendMessageOnce } = fakeMailbox();

    await expect(notifyDefaultHeapCeiling(defaultCeiling(), { mailbox })).resolves.toBe(true);

    const [input, key] = sendMessageOnce.mock.calls[0] as [MessageCreateInput, string];
    expect(input.fromId).toBe("system");
    expect(input.fromType).toBe("system");
    expect(input.toId).toBe(DASHBOARD_USER_ID);
    expect(input.toType).toBe("user");
    expect(input.type).toBe("system");
    expect(input.content).toBe(buildHeapCeilingNoticeContent(defaultCeiling()));
    expect(key).toMatch(/^heap-ceiling:v8-default:\d+$/);

    const metadata = input.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["heapLimitBytes", "isV8Default", "kind", "source"]);
    expect(metadata.kind).toBe("heap-ceiling-default-notice");
    expect(metadata.heapLimitBytes).toBe(V8_DEFAULT_BYTES);
    expect(metadata.source).toBe("v8-default");
    expect(metadata.isV8Default).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain(MAX_OLD_SPACE_FLAG);
  });
});

describe("heap ceiling notice — hostile or absent Mailbox", () => {
  it("resolves false when no message store exists (--no-engine / UI-only boots)", async () => {
    await expect(notifyDefaultHeapCeiling(defaultCeiling(), { mailbox: null })).resolves.toBe(false);
    await expect(notifyDefaultHeapCeiling(defaultCeiling(), {})).resolves.toBe(false);
  });

  it("resolves false when the mailbox throws synchronously", async () => {
    const mailbox = {
      sendMessageOnce: vi.fn(() => {
        throw new Error("sync boom");
      }),
    } as unknown as HeapCeilingMailbox;

    await expect(notifyDefaultHeapCeiling(defaultCeiling(), { mailbox })).resolves.toBe(false);
  });

  it("resolves false when the mailbox rejects", async () => {
    const mailbox = {
      sendMessageOnce: vi.fn(async () => {
        throw new Error("mailbox down");
      }),
    } as unknown as HeapCeilingMailbox;

    await expect(notifyDefaultHeapCeiling(defaultCeiling(), { mailbox })).resolves.toBe(false);
  });
});

/**
 * Step 4: the once-per-boot composition of the three lanes. `reportHeapCeilingAtBoot` is called from
 * `createServer()`, which is also the CLI and embedded-desktop boot path, so what these tests pin is what
 * every real boot does — including the shapes where a lane is missing entirely (`--no-engine`, a store that
 * cannot be reached, a mailbox that is down).
 */
function fakeAuditHost(behavior: "ok" | "throw" | "reject" = "ok") {
  const recordRunAuditEvent = vi.fn(() => {
    if (behavior === "throw") throw new Error("audit sink boom");
    if (behavior === "reject") {
      return Promise.reject(new Error("audit sink down"));
    }
    return Promise.resolve();
  });
  return { recordRunAuditEvent, auditHost: { recordRunAuditEvent } as never };
}

describe("heap ceiling boot report — the three lanes", () => {
  beforeEach(() => {
    resetHeapCeilingBootReportForTesting();
  });

  it("logs the resolved ceiling on every boot and warns only when nobody chose it", async () => {
    const defaultRun = fakeLogger();
    const { auditHost } = fakeAuditHost();
    const defaultResult = await reportHeapCeilingAtBoot({
      logger: defaultRun,
      ceiling: defaultCeiling(),
      auditHost,
    });

    expect(defaultResult.emitted).toBe(true);
    expect(defaultResult.warned).toBe(true);
    // The report line names the number AND the site, which is the half that was missing in the crash loop.
    expect(defaultRun.info.mock.calls[0][0]).toContain("Heap ceiling: 4.09 GiB");
    expect(defaultRun.info.mock.calls[0][0]).toContain("V8 default");
    expect(defaultRun.warn.mock.calls).toHaveLength(1);
    expect(defaultRun.warn.mock.calls[0][0]).toContain("dashboard-heap-growth-runbook.md");

    resetHeapCeilingBootReportForTesting();
    const declaredRun = fakeLogger();
    const declaredAudit = fakeAuditHost();
    const { mailbox, sendMessageOnce } = fakeMailbox();
    const declaredResult = await reportHeapCeilingAtBoot({
      logger: declaredRun,
      ceiling: declaredCeiling(),
      auditHost: declaredAudit.auditHost,
      resolveMailbox: () => mailbox,
    });

    expect(declaredResult).toMatchObject({ emitted: true, warned: false, noticeWritten: false });
    expect(declaredRun.info.mock.calls[0][0]).toContain("Heap ceiling: 16.09 GiB");
    // A host that declared its ceiling gets the fact, not a warning, and no audit row: the row is the
    // countable signal for the condition this card is about, and noise would bury it.
    expect(declaredRun.warn).not.toHaveBeenCalled();
    expect(declaredAudit.recordRunAuditEvent).not.toHaveBeenCalled();
    expect(sendMessageOnce).not.toHaveBeenCalled();
  });

  it("records exactly one runtime:heap-ceiling row whose metadata is numbers, one enum, one boolean", async () => {
    const { info } = fakeLogger();
    const { auditHost, recordRunAuditEvent } = fakeAuditHost();
    const nowMs = Date.UTC(2026, 9, 1, 12, 0, 0);

    await reportHeapCeilingAtBoot({
      logger: { info, warn: vi.fn() },
      ceiling: defaultCeiling(),
      auditHost,
      nowMs,
    });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const event = recordRunAuditEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(event.mutationType).toBe(HEAP_CEILING_MUTATION_TYPE);
    expect(event.domain).toBe("database");
    // The pid identifies the process without putting a path or launch-environment text in the row.
    expect(String(event.runId)).toMatch(new RegExp(`^${HEAP_CEILING_MUTATION_TYPE}:boot:\\d+$`));
    expect(event.agentId).toBe("dashboard-boot");
    expect(event.target).toBe("dashboard");

    const metadata = event.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(["heapLimitBytes", "isV8Default", "source"]);
    expect(metadata).toEqual({
      heapLimitBytes: V8_DEFAULT_BYTES,
      source: "v8-default",
      isV8Default: true,
    });
  });

  it("never puts launch-environment content in the audit row or the log context", async () => {
    const logger = fakeLogger();
    const { auditHost, recordRunAuditEvent } = fakeAuditHost();
    // The leak shape that matters for this row: a NODE_OPTIONS that carries other arguments but no
    // ceiling flag classifies as `v8-default`, so the default-case row is emitted while that raw string is
    // sitting in the environment. A connection string or credential argument there must stay there.
    const noisy = resolveHeapCeiling({
      execArgv: [],
      env: { NODE_OPTIONS: "--require=/opt/secret-loader.js?token=abc" },
      heapSizeLimitBytes: V8_DEFAULT_BYTES,
    });
    expect(noisy.isV8Default).toBe(true);

    await reportHeapCeilingAtBoot({ logger, ceiling: noisy, auditHost });

    const event = recordRunAuditEvent.mock.calls[0][0] as { metadata: unknown };
    const rendered = JSON.stringify([event.metadata, logger.info.mock.calls, logger.warn.mock.calls]);
    for (const secret of ["secret-loader", "token=abc", "8192"]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("reports once per process, so a second createServer() in the same boot cannot make the count lie", async () => {
    const logger = fakeLogger();
    const { auditHost, recordRunAuditEvent } = fakeAuditHost();
    const { mailbox, sendMessageOnce } = fakeMailbox();

    const first = await reportHeapCeilingAtBoot({
      logger,
      ceiling: defaultCeiling(),
      auditHost,
      resolveMailbox: () => mailbox,
    });
    const second = await reportHeapCeilingAtBoot({
      logger,
      ceiling: defaultCeiling(),
      auditHost,
      resolveMailbox: () => mailbox,
    });

    expect(first.emitted).toBe(true);
    expect(second).toEqual({ ceiling: defaultCeiling(), emitted: false, warned: false, noticeWritten: false });
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("still logs on a headless --no-engine boot that has neither a mailbox nor an audit sink", async () => {
    const logger = fakeLogger();

    const result = await reportHeapCeilingAtBoot({ logger, ceiling: defaultCeiling() });

    expect(result).toMatchObject({ emitted: true, warned: true, noticeWritten: false });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("cannot fail the boot it reports when every sink is hostile", async () => {
    const logger = fakeLogger();
    const { auditHost } = fakeAuditHost("throw");
    const rejectingMailbox = {
      sendMessageOnce: vi.fn(async () => {
        throw new Error("mailbox down");
      }),
    } as unknown as HeapCeilingMailbox;
    const resolveMailbox = vi.fn(() => {
      throw new Error("engine not ready");
    });

    await expect(
      reportHeapCeilingAtBoot({ logger, ceiling: defaultCeiling(), auditHost, resolveMailbox }),
    ).resolves.toMatchObject({ emitted: true, warned: true, noticeWritten: false });

    // A mailbox that cannot even be resolved must not take the log lane down with it.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(resolveMailbox).toHaveBeenCalledTimes(1);

    resetHeapCeilingBootReportForTesting();
    const rejectingRun = fakeLogger();
    const rejectingAudit = fakeAuditHost("reject");
    await expect(
      reportHeapCeilingAtBoot({
        logger: rejectingRun,
        ceiling: defaultCeiling(),
        auditHost: rejectingAudit.auditHost,
        resolveMailbox: () => rejectingMailbox,
      }),
    ).resolves.toMatchObject({ emitted: true, warned: true, noticeWritten: false });
  });

  it("writes the Mailbox notice through the same one-shot seam as the standalone helper", async () => {
    const logger = fakeLogger();
    const { auditHost } = fakeAuditHost();
    const { mailbox, sendMessageOnce } = fakeMailbox();
    const nowMs = Date.UTC(2026, 9, 1, 12, 0, 0);

    const result = await reportHeapCeilingAtBoot({
      logger,
      ceiling: defaultCeiling(),
      auditHost,
      resolveMailbox: () => mailbox,
      nowMs,
    });

    expect(result.noticeWritten).toBe(true);
    const [input, key] = sendMessageOnce.mock.calls[0] as [MessageCreateInput, string];
    expect(input.content).toBe(buildHeapCeilingNoticeContent(defaultCeiling()));
    expect(key).toBe(buildHeapCeilingNoticeIdempotencyKey(nowMs));
  });

  it("asks for the mailbox at report time, so a store attached after composition is still reachable", async () => {
    const logger = fakeLogger();
    let mailbox: HeapCeilingMailbox | null = null;
    const resolveMailbox = vi.fn(() => mailbox);

    // Not resolvable yet — the shape `createServer()` is in when the engine attaches its store later.
    const early = await reportHeapCeilingAtBoot({ logger, ceiling: defaultCeiling(), resolveMailbox });
    expect(early.noticeWritten).toBe(false);
    expect(resolveMailbox).toHaveBeenCalledTimes(1);

    resetHeapCeilingBootReportForTesting();
    const lateRun = fakeLogger();
    const lateMailbox = fakeMailbox();
    mailbox = lateMailbox.mailbox;
    const late = await reportHeapCeilingAtBoot({
      logger: lateRun,
      ceiling: defaultCeiling(),
      resolveMailbox,
    });

    expect(late.noticeWritten).toBe(true);
    expect(lateMailbox.sendMessageOnce).toHaveBeenCalledTimes(1);
  });
});
