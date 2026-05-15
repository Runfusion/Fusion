import { describe, expect, expectTypeOf, it } from "vitest";
import type { IEvent, IPty } from "node-pty";

type SpawnFn = typeof import("node-pty")["spawn"];

describe("node-pty ambient typing", () => {
  it("keeps desktop node-pty shim aligned with expected IPty surface", () => {
    const onDataEvent = ((listener: (data: string) => unknown) => {
      listener("data");
      return { dispose: () => undefined };
    }) satisfies IEvent<string>;

    const onExitEvent = ((listener: (e: { exitCode: number; signal?: number }) => unknown) => {
      listener({ exitCode: 0, signal: 15 });
      return { dispose: () => undefined };
    }) satisfies IEvent<{ exitCode: number; signal?: number }>;

    const pty: IPty = {
      pid: 1,
      cols: 80,
      rows: 24,
      process: "bash",
      handleFlowControl: false,
      onData: onDataEvent,
      onExit: onExitEvent,
      resize: (_cols: number, _rows: number) => undefined,
      on: (_event: "data" | "exit", _listener: ((data: string) => void) | ((exitCode: number, signal?: number) => void)) => undefined,
      clear: () => undefined,
      write: (_data: string) => undefined,
      kill: (_signal?: string) => undefined,
      pause: () => undefined,
      resume: () => undefined,
    };

    expectTypeOf(pty.kill).toEqualTypeOf<(signal?: string) => void>();
    expectTypeOf(pty.onData).toEqualTypeOf<IEvent<string>>();
    expectTypeOf(pty.onExit).toEqualTypeOf<IEvent<{ exitCode: number; signal?: number }>>();
    expectTypeOf(pty.write).toEqualTypeOf<(data: string) => void>();
    expectTypeOf(pty.resize).toEqualTypeOf<(cols: number, rows: number) => void>();
    expectTypeOf<SpawnFn>().returns.toEqualTypeOf<IPty>();
    expect(true).toBe(true);
  });
});
