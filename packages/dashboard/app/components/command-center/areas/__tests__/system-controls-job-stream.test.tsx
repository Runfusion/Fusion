import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SystemControlsArea } from "../SystemControlsArea";
import { __sseBusResyncAudit, SSE_HIDDEN_SUSPEND_DELAY_MS } from "../../../../sse-bus";
import {
  fetchCurrentSystemRebuild,
  fetchSystemInfo,
  type SystemInfoResponse,
  type SystemRebuildJobSnapshot,
} from "../../../../api/legacy";

/*
FNXC:SystemPanelJobStreamResync 2026-07-26-16:40:
Regression coverage for the System panel's rebuild-job stream across the 60s hidden-tab suspend.

Verified server contract (packages/dashboard/src/routes/register-system-routes.ts,
GET /system/jobs/:id/stream): the route replays every buffered line from `Last-Event-ID + 1` (0 for
the fresh EventSource the bus creates on resume) and, when `job.status !== "running"`, writes a
terminal `end` snapshot and closes. That makes the stream replay-safe ONLY while the job's server
process is alive — `jobsById` is process-local in-memory state, so a "Rebuild & restart" job that
finishes and bounces the server answers 404 on reconnect and never delivers `end`.

The `end` handler is the sole writer of the terminal snapshot and of restartPhase="waiting", so
without a resync the panel shows "Running…" forever. Both surfaces are covered here:
  1. server survived  → replay + `end` reaches the terminal state, and the reconnect resync must not
     double-apply it (one toast, not two);
  2. server restarted → the reconnect is a 404 that never fires `open` (therefore never fires
     `onReconnect`), so only `onError` can recover; the panel must leave "Running…" and reach the
     back-online reload path.
This test uses the REAL sse-bus with a fake EventSource so the suspend/resume machinery under test is
the shipped one, not a stand-in.
*/

vi.mock("../../../../api/legacy", () => ({
  fetchSystemInfo: vi.fn(),
  fetchCurrentSystemRebuild: vi.fn(),
  fetchDashboardHealth: vi.fn().mockResolvedValue({ ok: true }),
  fetchSystemLogs: vi.fn().mockResolvedValue({ entries: [] }),
  createBackup: vi.fn(),
  refreshUpdateCheck: vi.fn(),
  reloadAllSystemPlugins: vi.fn(),
  requestSystemRestart: vi.fn(),
  restartAllSystemAgents: vi.fn(),
  restartSystemEngines: vi.fn(),
  startFnBinaryLinkLocal: vi.fn(),
  startFnBinaryUseGlobal: vi.fn(),
  startSystemRebuild: vi.fn(),
}));

vi.mock("../../../ReportActionMenu", () => ({ ReportActionMenu: () => null }));
vi.mock("../../../ReportModal", () => ({ ReportModal: () => null }));

const fetchSystemInfoMock = vi.mocked(fetchSystemInfo);
const fetchCurrentSystemRebuildMock = vi.mocked(fetchCurrentSystemRebuild);

// ── Fake EventSource ────────────────────────────────────────────────────────
type Listener = (event: Event) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Server accepted the connection. */
  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatch("open");
  }

  /** Server refused it (e.g. 404 after the process restarted) — no `open` ever fires. */
  emitError(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatch("error");
  }

  emitNamed(type: string, data: unknown): void {
    this.dispatch(type, JSON.stringify(data));
  }

  private dispatch(type: string, data?: string): void {
    const event = data === undefined ? new Event(type) : Object.assign(new Event(type), { data });
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

function jobStreamSources(jobId: string): FakeEventSource[] {
  return FakeEventSource.instances.filter((es) => es.url.includes(`/api/system/jobs/${jobId}/stream`));
}

function latestJobStream(jobId: string): FakeEventSource {
  const all = jobStreamSources(jobId);
  const last = all[all.length - 1];
  if (!last) throw new Error(`no EventSource opened for job ${jobId}`);
  return last;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function info(pid: number): SystemInfoResponse {
  return {
    supervised: true,
    restartSupported: true,
    rebuildSupported: true,
    fnBinaryLinkLocalSupported: true,
    fnBinaryUseGlobalSupported: true,
    sourceWorkspaceRoot: "/repo",
    logsSupported: true,
    engineAvailable: true,
    pluginReloadSupported: true,
    pid,
    uptimeSeconds: 42,
    nodeVersion: "v22.0.0",
    platform: "darwin",
    arch: "arm64",
    memoryRssBytes: 1024,
    activeRebuild: null,
    lastRebuild: null,
  };
}

const JOB_ID = "job-rebuild-1";

function runningJob(): SystemRebuildJobSnapshot {
  return {
    id: JOB_ID,
    kind: "rebuild",
    scope: "app",
    restartAfter: true,
    status: "running",
    startedAt: 1_000,
    droppedLines: 0,
    lineCount: 1,
    lines: [{ i: 0, ts: 1_000, stream: "system", text: "Building…" }],
  };
}

function succeededJob(restartScheduled: boolean): SystemRebuildJobSnapshot {
  return {
    ...runningJob(),
    restartAfter: restartScheduled,
    status: "succeeded",
    finishedAt: 2_000,
    exitCode: 0,
    restartScheduled,
    lineCount: 2,
    lines: [
      { i: 0, ts: 1_000, stream: "system", text: "Building…" },
      { i: 1, ts: 2_000, stream: "system", text: "Build succeeded." },
    ],
  };
}

// ── Visibility control ──────────────────────────────────────────────────────
let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const originalLocation = window.location;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
let reloadSpy: ReturnType<typeof vi.fn>;
let toasts: Array<{ message: string; type?: string }>;

function addToast(message: string, type?: string): void {
  toasts.push({ message, type });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Render with a running job already in flight and its stream connected. */
async function renderWithRunningJob(): Promise<void> {
  fetchSystemInfoMock.mockResolvedValue(info(1000));
  fetchCurrentSystemRebuildMock.mockResolvedValue({ job: runningJob() });
  render(<SystemControlsArea addToast={addToast as (m: string, t?: never) => void} />);
  await flush();
  expect(screen.getByText("Running…")).toBeInTheDocument();
  latestJobStream(JOB_ID).emitOpen();
  await flush();
}

/** Hide the tab past the suspend threshold, then bring it back. */
async function hideBeyondSuspendThenReturn(): Promise<void> {
  setVisibility("hidden");
  await flush(SSE_HIDDEN_SUSPEND_DELAY_MS + 1_000);
  const beforeResume = jobStreamSources(JOB_ID).length;
  setVisibility("visible");
  await flush();
  // The bus must have opened a fresh transport for the resumed channel.
  expect(jobStreamSources(JOB_ID).length).toBeGreaterThan(beforeResume);
}

describe("SystemControlsArea rebuild-job stream across the hidden-tab suspend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    toasts = [];
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    // jsdom has no layout: the panel scrolls its job section into view on start.
    Element.prototype.scrollIntoView = vi.fn();
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, origin: originalLocation.origin, href: originalLocation.href, reload: reloadSpy },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("declares a resync path for the job stream (sse-bus contract audit)", async () => {
    await renderWithRunningJob();
    expect(Object.keys(__sseBusResyncAudit())).not.toContain(`/api/system/jobs/${JOB_ID}/stream`);
  });

  it("reaches the terminal state from the replayed end event when the server survived, applying it once", async () => {
    await renderWithRunningJob();

    // Job completes while the tab is hidden; server process survives (no restart scheduled).
    const terminal = succeededJob(false);
    fetchCurrentSystemRebuildMock.mockResolvedValue({ job: terminal });

    await hideBeyondSuspendThenReturn();

    // Real server behavior on reconnect: replay the buffered lines, then the terminal `end`.
    const stream = latestJobStream(JOB_ID);
    stream.emitOpen();
    for (const line of terminal.lines ?? []) stream.emitNamed("line", line);
    stream.emitNamed("end", { ...terminal, lines: undefined });
    await flush();
    // Let the staggered onReconnect resync (which raced the `end`) settle too.
    await flush(5_000);

    expect(screen.queryByText("Running…")).toBeNull();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(toasts.filter((entry) => entry.message === "Rebuild finished successfully")).toHaveLength(1);
  });

  it("recovers when the rebuild restarted the server while hidden and the stream 404s (no end event)", async () => {
    await renderWithRunningJob();

    // The job finished and restarted the server. The new process has no record of the job, and its
    // PID differs. This is the case the stream cannot replay.
    fetchCurrentSystemRebuildMock.mockResolvedValue({ job: null });
    fetchSystemInfoMock.mockResolvedValue(info(2000));

    await hideBeyondSuspendThenReturn();

    // 404 → EventSource errors without ever firing `open`, so `onReconnect` never runs.
    latestJobStream(JOB_ID).emitError();
    await flush();

    expect(screen.queryByText("Running…")).toBeNull();
    expect(screen.getByText("Server is back online — reloading…")).toBeInTheDocument();

    await flush(5_000);
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("reports an unknown outcome rather than a permanent Running… when the job vanished without a restart", async () => {
    await renderWithRunningJob();

    // Same process (same PID), job no longer known: we cannot prove success or failure.
    fetchCurrentSystemRebuildMock.mockResolvedValue({ job: null });
    fetchSystemInfoMock.mockResolvedValue(info(1000));

    await hideBeyondSuspendThenReturn();
    latestJobStream(JOB_ID).emitError();
    await flush();

    expect(screen.queryByText("Running…")).toBeNull();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(toasts.map((entry) => entry.message)).toContain(
      "Lost the job stream before a result arrived — the outcome is unknown",
    );
  });
});
