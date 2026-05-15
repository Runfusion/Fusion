import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("InProcessRuntime onStart duplicate guard", () => {
  it("contains a taskAgentMap guard before creating task-worker agents", () => {
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("if (this.taskAgentMap.has(task.id))");
    expect(source).toContain("Skipping task-worker creation for");
  });

  it("exposes getChatStore and wires HeartbeatMonitor to the runtime chatStore instance", () => {
    const source = readFileSync(join(process.cwd(), "src/runtimes/in-process-runtime.ts"), "utf-8");
    expect(source).toContain("this.chatStore ??= new ChatStore(this.taskStore.getFusionDir(), this.taskStore.getDatabase());");
    expect(source).toContain("chatStore: this.chatStore,");
    expect(source).toContain("getChatStore(): import(\"@fusion/core\").ChatStore | undefined {");
    expect(source).toContain("return this.chatStore;");
  });
});
