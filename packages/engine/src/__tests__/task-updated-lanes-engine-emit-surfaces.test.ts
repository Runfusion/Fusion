import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TaskStore, type Task } from "@fusion/core";
import { HybridExecutor } from "../hybrid-executor.js";
import { ProjectManager } from "../project-manager.js";
import { ChildProcessRuntime } from "../runtimes/child-process-runtime.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import { RemoteNodeRuntime } from "../runtimes/remote-node-runtime.js";
import { TASK_UPDATED } from "../ipc/ipc-protocol.js";

const REPO_ROOT = resolve(__dirname, "../../../..");
const ENGINE_ROOT = join(REPO_ROOT, "packages/engine/src");

const DROP_BRIDGES = {
  "packages/engine/src/hybrid-executor.ts": "HybridExecutor",
  "packages/engine/src/project-manager.ts": "ProjectManager",
  "packages/engine/src/runtimes/child-process-runtime.ts": "ChildProcessRuntime",
  "packages/engine/src/runtimes/in-process-runtime.ts": "InProcessRuntime",
  "packages/engine/src/runtimes/remote-node-runtime.ts": "RemoteNodeRuntime",
} as const;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

const task = { id: "FN-bridge-surface", column: "building" } as Task;

/**
 * FNXC:WorkflowEvents 2026-08-01-06:57:
 * Runtime and manager update emitters are deliberately tested by executing their actual forwarding
 * registrations. They are EventEmitter DROP boundaries rather than TaskStore seams: only the Task
 * crosses the serialized/runtime boundary, and the receiving listener treats missing lanes as unknown.
 */
describe("engine task:updated emit surface", () => {
  it("registers every engine emitter as an explicit DROP bridge", () => {
    const emittingModules = [...walk(ENGINE_ROOT)]
      .filter((file) => readFileSync(file, "utf8").includes('emit("task:updated"'))
      .map((file) => relative(REPO_ROOT, file).split("\\").join("/"))
      .sort();

    expect(emittingModules).toEqual(Object.keys(DROP_BRIDGES).sort());
    for (const file of emittingModules) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source).toMatch(new RegExp(`${DROP_BRIDGES[file as keyof typeof DROP_BRIDGES]}\\s+extends\\s+EventEmitter`));
      expect(source).toContain('this.emit("task:updated"');
    }
  });

  it("executes each DROP bridge with a well-formed lanes-free task payload", () => {
    const hybridUpstream = new EventEmitter();
    const hybrid = Object.assign(new EventEmitter(), { projectManager: hybridUpstream });
    (HybridExecutor.prototype as any).setupEventForwarding.call(hybrid);

    const managerUpstream = new EventEmitter();
    const manager = Object.assign(new EventEmitter(), { logActivity: async () => undefined });
    (ProjectManager.prototype as any).setupEventForwarding.call(manager, managerUpstream, "project", "Project");

    const inProcessUpstream = new EventEmitter();
    const inProcess = Object.assign(new EventEmitter(), {
      taskStore: inProcessUpstream,
      recordActivity: () => undefined,
      config: { projectId: "project" },
    });
    (InProcessRuntime.prototype as any).setupEventForwarding.call(inProcess);

    const childUpstream = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { ipcHost: childUpstream });
    (ChildProcessRuntime.prototype as any).setupEventForwarding.call(child);

    const remote = new RemoteNodeRuntime({
      nodeConfig: { id: "node", name: "node", url: "https://remote.invalid", apiKey: "test" },
      projectId: "project",
      projectName: "Project",
    });

    const cases: Array<{ receiver: EventEmitter; upstream: EventEmitter; emit: () => void; unwrap?: (value: unknown) => unknown }> = [
      { receiver: hybrid, upstream: hybridUpstream, emit: () => hybridUpstream.emit("task:updated", task) },
      { receiver: manager, upstream: managerUpstream, emit: () => managerUpstream.emit("task:updated", task), unwrap: (value) => (value as { task: Task }).task },
      { receiver: inProcess, upstream: inProcessUpstream, emit: () => inProcessUpstream.emit("task:updated", task) },
      { receiver: child, upstream: childUpstream, emit: () => childUpstream.emit(TASK_UPDATED, { task }) },
      { receiver: remote, upstream: remote, emit: () => (remote as any).forwardRemoteEvent({ type: "task:updated", payload: task }) },
    ];

    for (const bridge of cases) {
      expect(bridge.receiver).not.toBeInstanceOf(TaskStore);
      const received: unknown[][] = [];
      bridge.receiver.on("task:updated", (...args: unknown[]) => received.push(args));
      bridge.emit();
      expect(received).toHaveLength(1);
      expect(bridge.unwrap?.(received[0][0]) ?? received[0][0]).toBe(task);
      expect(received[0][1]).toBeUndefined();
    }
  });
});
