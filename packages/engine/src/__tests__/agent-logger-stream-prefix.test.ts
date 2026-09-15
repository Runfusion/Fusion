import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLogEntry, TaskStore } from "@fusion/core";
import { appendAgentLogEntriesSync, readAgentLogEntries } from "../../../core/src/agents/agent-log-file-store.js";
import { AgentLogger } from "../agents/agent-logger.js";
import { createAssistantStreamCapture } from "../execution/assistant-text-capture.js";
import {
  createAssistantStreamProducer,
  queueReproStream,
  REPRO_PREFIX,
  REPRO_RESPONSE,
  REPRO_SUFFIX,
} from "./fixtures/assistant-stream-events.js";

/*
FNXC:AssistantTextCapture 2026-09-15-22:20:
FN-431: the duplicated response prefix was reported in TASK LOGS as well as chat, so this case runs
the real capture through the real AgentLogger down to the real JSONL file store. Concatenating the
persisted text entries, in order, must rebuild the response exactly once whatever the flush split is.
*/

vi.mock("../logger.js", () => ({
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TASK_ID = "FN-431";

describe("agent log streaming keeps the assistant response prefix exactly once", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "fusion-fn431-agent-log-"));
  });

  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
  });

  /** A store port backed by the production JSONL writer/reader. */
  function fileBackedStore(mode: "batch" | "single"): TaskStore {
    const append = (entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"] }>) => {
      appendAgentLogEntriesSync(taskDir, entries.map((entry) => ({ ...entry, timestamp: new Date().toISOString() })));
    };
    const store: Record<string, unknown> = {
      appendAgentLog: async (taskId: string, text: string, type: AgentLogEntry["type"], detail?: string, agent?: AgentLogEntry["agent"]) => {
        append([{ taskId, text, type, detail, agent }]);
      },
    };
    if (mode === "batch") {
      store.appendAgentLogBatch = async (entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"] }>) => {
        append(entries);
      };
    }
    return store as unknown as TaskStore;
  }

  function persistedText(): string {
    return readAgentLogEntries(taskDir)
      .filter((entry) => entry.type === "text")
      .map((entry) => entry.text)
      .join("");
  }

  for (const mode of ["batch", "single"] as const) {
    it(`rebuilds the response from persisted ${mode} entries without repeating its opening`, async () => {
      const logger = new AgentLogger({ store: fileBackedStore(mode), taskId: TASK_ID, agent: "executor", flushSizeBytes: 1, flushIntervalMs: 5 });
      const capture = createAssistantStreamCapture({ onText: logger.onText, onThinking: logger.onThinking });

      const producer = createAssistantStreamProducer();
      const index = queueReproStream(producer);
      producer.drain(capture.handleAgentEvent);
      await logger.flush();
      expect(persistedText()).toBe(REPRO_PREFIX);

      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(capture.handleAgentEvent);
      await logger.flush();

      expect(persistedText()).toBe(REPRO_RESPONSE);
      expect(persistedText()).not.toBe(REPRO_PREFIX + REPRO_RESPONSE);
      // A second read of the same file must not change what was persisted.
      expect(persistedText()).toBe(REPRO_RESPONSE);
    });
  }

  it("keeps thinking and a tool boundary out of the persisted assistant text", async () => {
    const logger = new AgentLogger({
      store: fileBackedStore("batch"),
      taskId: TASK_ID,
      agent: "executor",
      flushSizeBytes: 1,
      flushIntervalMs: 5,
      persistAgentThinkingLog: true,
    });
    const capture = createAssistantStreamCapture({ onText: logger.onText, onThinking: logger.onThinking });

    const producer = createAssistantStreamProducer();
    producer.messageStart();
    const thinkingIndex = producer.startBlock("thinking");
    producer.delta("thinking", thinkingIndex, "Reasoning first.");
    const textIndex = producer.startBlock("text");
    producer.delta("text", textIndex, REPRO_PREFIX);
    producer.drain(capture.handleAgentEvent);
    await logger.flush();
    logger.onToolStart("Read", { path: "src/index.ts" });
    producer.delta("text", textIndex, REPRO_SUFFIX);
    producer.endBlock("text", textIndex);
    producer.messageEnd();
    producer.drain(capture.handleAgentEvent);
    await logger.flush();

    const entries = readAgentLogEntries(taskDir);
    expect(entries.filter((entry) => entry.type === "text").map((entry) => entry.text).join("")).toBe(REPRO_RESPONSE);
    expect(entries.filter((entry) => entry.type === "thinking").map((entry) => entry.text).join("")).toBe("Reasoning first.");
  });

  it("persists an intentionally repeated opening twice", async () => {
    const logger = new AgentLogger({ store: fileBackedStore("batch"), taskId: TASK_ID, agent: "executor", flushSizeBytes: 1, flushIntervalMs: 5 });
    const capture = createAssistantStreamCapture({ onText: logger.onText });

    const producer = createAssistantStreamProducer();
    producer.messageStart();
    const index = producer.startBlock("text");
    producer.delta("text", index, REPRO_PREFIX);
    producer.delta("text", index, REPRO_PREFIX);
    producer.endBlock("text", index);
    producer.messageEnd();
    producer.drain(capture.handleAgentEvent);
    await logger.flush();

    expect(persistedText()).toBe(REPRO_PREFIX + REPRO_PREFIX);
  });
});
