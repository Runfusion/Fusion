/**
 * RUFU-301: the task-ID integrity detector may never answer "clean" about a
 * measurement it did not finish.
 *
 * FNXC:TaskIdIntegrityCanary 2026-09-26-02:07 (RUFU-301):
 * The detector's `catch { return buildReport(checkedAt, []) }` turned every query
 * failure — statement cancellation, lock queue, connection loss, permission
 * denial — into `status: "ok"` with zero anomalies, which is the same payload a
 * completed scan produces. The canary therefore could not fail, and the dashboard
 * published `corruptionDetected: false` on the strength of a read that never
 * returned. These tests pin the replacement contract (raise, with the driver's
 * reason) AND the two controls that make the failure assertions non-vacuous: a
 * consistent corpus still reports ok, and a corrupt corpus still reports anomaly.
 */

import { describe, expect, it } from "vitest";
import {
  detectTaskIdIntegrityAnomaliesAsync,
  TaskIdIntegrityMeasurementError,
} from "../async-task-id-integrity.js";

/**
 * Minimal `PgDb` double: the detector issues exactly three reads — active ids,
 * archived ids, allocator state — so each call answers from a scripted list.
 *
 * @param responses One entry per read; an `Error` makes that read fail.
 */
function fakeDb(responses: Array<Array<Record<string, unknown>> | Error>): any {
  let call = 0;
  return {
    async execute() {
      const response = responses[call++];
      if (response instanceof Error) throw response;
      if (response === undefined) {
        throw new Error(`unexpected fourth integrity read (test scripted only ${responses.length})`);
      }
      return response;
    },
  };
}

const CONSISTENT = [
  [{ id: "FN-1" }, { id: "FN-2" }],
  [{ id: "FN-3" }],
  [{ prefix: "FN", next_sequence: 4 }],
];

describe("detectTaskIdIntegrityAnomaliesAsync fail-closed contract", () => {
  it("rejects instead of reporting ok when the active-id read fails", async () => {
    const cancellation = new Error("canceling statement due to statement timeout");

    const attempt = detectTaskIdIntegrityAnomaliesAsync(
      fakeDb([cancellation, [], []]),
    );

    await expect(attempt).rejects.toBeInstanceOf(TaskIdIntegrityMeasurementError);
    await expect(attempt).rejects.toThrow(/canceling statement due to statement timeout/);
  });

  it("keeps the driver's error as the cause so the health surface can name it", async () => {
    const lostConnection = new Error("connection terminated");

    const error = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb([CONSISTENT[0], lostConnection, []]),
    ).catch((caught: unknown) => caught as TaskIdIntegrityMeasurementError);

    expect(error).toBeInstanceOf(TaskIdIntegrityMeasurementError);
    expect(error.cause).toBe(lostConnection);
  });

  it("rejects when only the allocator-state read fails after two good reads", async () => {
    // This is the exact old fail-open shape: both id reads succeeded, the state
    // read was cancelled, and the detector answered `status: "ok"` with zero
    // anomalies — a partial measurement published as a clean verdict.
    const attempt = detectTaskIdIntegrityAnomaliesAsync(
      fakeDb([CONSISTENT[0], CONSISTENT[1], new Error("permission denied for table distributed_task_id_state")]),
    );

    await expect(attempt).rejects.toBeInstanceOf(TaskIdIntegrityMeasurementError);
  });

  it("does not double-wrap a measurement failure that is already classified", async () => {
    const first = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb([new Error("first failure")]),
    ).catch((caught: unknown) => caught as TaskIdIntegrityMeasurementError);

    const second = await detectTaskIdIntegrityAnomaliesAsync({
      async execute() {
        throw first;
      },
    } as any).catch((caught: unknown) => caught as TaskIdIntegrityMeasurementError);

    expect(second).toBe(first);
  });

  it("still reports a completed clean scan as ok", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(fakeDb(CONSISTENT));

    expect(report.status).toBe("ok");
    expect(report.anomalies).toEqual([]);
  });

  it("still reports a real anomaly, so the failure assertions are not vacuous", async () => {
    const report = await detectTaskIdIntegrityAnomaliesAsync(
      fakeDb([[{ id: "FN-1" }, { id: "FN-1" }], [], [{ prefix: "FN", next_sequence: 2 }]]),
    );

    expect(report.status).toBe("anomaly");
    expect(report.anomalies.map((anomaly) => anomaly.kind)).toContain("duplicate_active_id");
  });
});
