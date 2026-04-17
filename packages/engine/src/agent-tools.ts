/**
 * Shared agent tool factory functions.
 *
 * Extracted from TaskExecutor so they can be reused by other subsystems
 * (e.g., HeartbeatMonitor execution) without pulling in the full executor.
 *
 * The parameter schemas are canonical here — executor.ts imports and reuses them.
 */

import { appendFile } from "node:fs/promises";
import type { AgentStore, AgentState, AgentCapability, TaskDocument, TaskDocumentCreateInput, TaskStore, RunMutationContext, MessageStore, Message } from "@fusion/core";
import { dailyMemoryPath, ensureOpenClawMemoryFiles, getMemoryBackendCapabilities, getProjectMemory, isEphemeralAgent, memoryLongTermPath, searchProjectMemory } from "@fusion/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentReflectionService } from "./agent-reflection.js";

// ── Tool parameter schemas (canonical definitions) ────────────────────────

export const taskCreateParams = Type.Object({
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
});

export const taskLogParams = Type.Object({
  message: Type.String({ description: "What happened" }),
  outcome: Type.Optional(Type.String({ description: "Result or consequence (optional)" })),
});

export const taskDocumentWriteParams = Type.Object({
  key: Type.String({
    description: "Document key (e.g., 'plan', 'notes', 'research'). Alphanumeric, hyphens, underscores, 1-64 chars.",
  }),
  content: Type.String({ description: "Document content to store" }),
  author: Type.Optional(Type.String({ description: "Who is writing (default: 'agent')" })),
});

export const taskDocumentReadParams = Type.Object({
  key: Type.Optional(
    Type.String({ description: "Document key to read. Omit to list all documents for this task." }),
  ),
});

export const reflectOnPerformanceParams = Type.Object({
  focus_area: Type.Optional(
    Type.String({ description: "Optional focus area for reflection (e.g., 'code quality', 'speed', 'testing')" }),
  ),
});

export const listAgentsParams = Type.Object({
  role: Type.Optional(
    Type.String({ description: "Filter by agent role/capability (e.g., 'executor', 'reviewer', 'qa')" }),
  ),
  state: Type.Optional(
    Type.String({ description: "Filter by agent state (e.g., 'idle', 'active', 'running')" }),
  ),
  includeEphemeral: Type.Optional(
    Type.Boolean({ description: "Include ephemeral/runtime agents (default: false)" }),
  ),
});

export const delegateTaskParams = Type.Object({
  agent_id: Type.String({ description: "The agent ID to delegate work to" }),
  description: Type.String({ description: "What needs to be done" }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this new task depends on (e.g. [\"KB-001\"])" }),
  ),
});

export const sendMessageParams = Type.Object({
  to_id: Type.String({ description: "Recipient ID (agent ID or user ID, depending on message type)" }),
  content: Type.String({ description: "Message body (1-2000 characters)" }),
  type: Type.Optional(Type.Union([
    Type.Literal("agent-to-agent"),
    Type.Literal("agent-to-user"),
  ], { description: "Message type (defaults to 'agent-to-agent')" })),
});

export const readMessagesParams = Type.Object({
  unread_only: Type.Optional(Type.Boolean({ description: "Only return unread messages (default: true)" })),
  limit: Type.Optional(Type.Number({ description: "Max messages to return (default: 20)" })),
});

export const memorySearchParams = Type.Object({
  query: Type.String({ description: "Search terms for durable project memory. Use focused keywords, not a full prompt." }),
  limit: Type.Optional(Type.Number({ description: "Maximum snippets to return (default: 5, max: 20)" })),
});

export const memoryGetParams = Type.Object({
  path: Type.String({ description: "Memory path from memory_search, e.g. .fusion/memory/MEMORY.md or .fusion/memory/YYYY-MM-DD.md" }),
  startLine: Type.Optional(Type.Number({ description: "1-based start line (default: 1)" })),
  lineCount: Type.Optional(Type.Number({ description: "Number of lines to read (default: 120, max: 400)" })),
});

export const memoryAppendParams = Type.Object({
  layer: Type.Union([
    Type.Literal("long-term"),
    Type.Literal("daily"),
  ], { description: "long-term for durable conventions/decisions/pitfalls, daily for running notes/open loops" }),
  content: Type.String({ description: "Markdown content to append. Keep it concise and reusable." }),
});

type MemoryToolSettings = {
  memoryBackendType?: string;
  [key: string]: unknown;
};

// ── Tool factory functions ────────────────────────────────────────────────

/**
 * Create a `task_create` tool that creates a new task in triage.
 *
 * @param store - TaskStore for task persistence
 * @returns ToolDefinition for the `task_create` tool
 */
export function createTaskCreateTool(store: TaskStore): ToolDefinition {
  return {
    name: "task_create",
    label: "Create Task",
    description:
      "Create a new task for out-of-scope work discovered during execution. " +
      "The task goes into triage where it will be specified by the AI. " +
      "Optionally set dependencies (e.g., the new task depends on the current one, " +
      "or the current task should wait for the new one).",
    parameters: taskCreateParams,
    execute: async (_id: string, params: Static<typeof taskCreateParams>) => {
      const task = await store.createTask({
        description: params.description,
        dependencies: params.dependencies,
        column: "triage",
      });
      const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Created ${task.id}: ${params.description}${deps}`,
        }],
        details: {},
      };
    },
  };
}

/**
 * Create a `task_log` tool that logs an entry for a specific task.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @returns ToolDefinition for the `task_log` tool
 */
export function createTaskLogTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      await store.logEntry(taskId, params.message, params.outcome);
      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}

/**
 * Create a `task_log` tool with run context for mutation correlation.
 *
 * @param store - TaskStore for task persistence
 * @param taskId - The task ID to log entries against
 * @param runContext - Optional run context for mutation correlation
 * @returns ToolDefinition for the `task_log` tool
 */
export function createTaskLogToolWithContext(store: TaskStore, taskId: string, runContext?: RunMutationContext): ToolDefinition {
  return {
    name: "task_log",
    label: "Log Entry",
    description:
      "Log an important action, decision, or issue for this task. " +
      "Use for significant events — not every small step.",
    parameters: taskLogParams,
    execute: async (_id: string, params: Static<typeof taskLogParams>) => {
      await store.logEntry(taskId, params.message, params.outcome, runContext);
      return {
        content: [{ type: "text" as const, text: `Logged: ${params.message}` }],
        details: {},
      };
    },
  };
}

/**
 * Create a `task_document_write` tool that stores a named task document.
 *
 * @param store - TaskStore for task document persistence
 * @param taskId - The task ID to write documents against
 * @returns ToolDefinition for the `task_document_write` tool
 */
export function createTaskDocumentWriteTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_document_write",
    label: "Write Document",
    description:
      "Save a named document for this task (for example plan, notes, or research). " +
      "Each write creates a new revision so you can update documents over time.",
    parameters: taskDocumentWriteParams,
    execute: async (_id: string, params: Static<typeof taskDocumentWriteParams>) => {
      const input: TaskDocumentCreateInput = {
        key: params.key,
        content: params.content,
        author: params.author || "agent",
      };

      try {
        const document: TaskDocument = await store.upsertTaskDocument(taskId, input);
        return {
          content: [{
            type: "text" as const,
            text: `Saved document "${document.key}" (revision ${document.revision}).`,
          }],
          details: {},
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to save document "${params.key}": ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `task_document_read` tool that reads task-scoped documents.
 *
 * @param store - TaskStore for task document reads
 * @param taskId - The task ID to read documents from
 * @returns ToolDefinition for the `task_document_read` tool
 */
export function createTaskDocumentReadTool(store: TaskStore, taskId: string): ToolDefinition {
  return {
    name: "task_document_read",
    label: "Read Document",
    description:
      "Read a named document for this task, or list all documents when no key is provided.",
    parameters: taskDocumentReadParams,
    execute: async (_id: string, params: Static<typeof taskDocumentReadParams>) => {
      try {
        if (params.key) {
          const document: TaskDocument | null = await store.getTaskDocument(taskId, params.key);
          if (!document) {
            return {
              content: [{ type: "text" as const, text: `Document "${params.key}" not found.` }],
              details: {},
            };
          }

          return {
            content: [{
              type: "text" as const,
              text:
                `Document: ${document.key}\n` +
                `Revision: ${document.revision}\n` +
                `Updated: ${document.updatedAt}\n\n` +
                document.content,
            }],
            details: {},
          };
        }

        const documents: TaskDocument[] = await store.getTaskDocuments(taskId);
        if (documents.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No documents found for this task." }],
            details: {},
          };
        }

        const lines = documents.map((doc) => `- ${doc.key} (revision ${doc.revision}, updated ${doc.updatedAt})`);
        return {
          content: [{
            type: "text" as const,
            text: `Task documents:\n${lines.join("\n")}`,
          }],
          details: {},
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Failed to read task documents: ${err.message}`,
          }],
          details: {},
        };
      }
    },
  };
}

export function createMemorySearchTool(rootDir: string, settings?: MemoryToolSettings): ToolDefinition {
  return {
    name: "memory_search",
    label: "Search Memory",
    description:
      "Search durable project memory and return small snippets with file paths and line ranges. " +
      "Use this before memory_get; do not read all memory by default.",
    parameters: memorySearchParams,
    execute: async (_id: string, params: Static<typeof memorySearchParams>) => {
      const results = await searchProjectMemory(rootDir, {
        query: params.query,
        limit: params.limit,
      }, settings);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "NONE" }],
          details: { results: [] },
        };
      }

      const text = results.map((result, index) => [
        `${index + 1}. ${result.path}:${result.lineStart}-${result.lineEnd} (score ${result.score}, ${result.backend})`,
        result.snippet,
      ].join("\n")).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { results } };
    },
  };
}

export function createMemoryGetTool(rootDir: string, settings?: MemoryToolSettings): ToolDefinition {
  return {
    name: "memory_get",
    label: "Get Memory",
    description:
      "Read a bounded line window from a memory file returned by memory_search. " +
      "Allowed files are .fusion/memory/MEMORY.md, .fusion/memory/YYYY-MM-DD.md, and legacy .fusion/memory.md.",
    parameters: memoryGetParams,
    execute: async (_id: string, params: Static<typeof memoryGetParams>) => {
      const result = await getProjectMemory(rootDir, {
        path: params.path,
        startLine: params.startLine,
        lineCount: params.lineCount,
      }, settings);
      return {
        content: [{
          type: "text" as const,
          text: `${result.path}:${result.startLine}-${result.endLine} (${result.totalLines} total lines, ${result.backend})\n\n${result.content}`,
        }],
        details: result,
      };
    },
  };
}

export function createMemoryAppendTool(rootDir: string): ToolDefinition {
  return {
    name: "memory_append",
    label: "Append Memory",
    description:
      "Append concise Markdown to project memory. Use long-term only for durable conventions/decisions/pitfalls; " +
      "use daily for running observations and open loops. Skip this tool when there is no reusable memory.",
    parameters: memoryAppendParams,
    execute: async (_id: string, params: Static<typeof memoryAppendParams>) => {
      await ensureOpenClawMemoryFiles(rootDir);
      const targetPath = params.layer === "long-term" ? memoryLongTermPath(rootDir) : dailyMemoryPath(rootDir);
      const content = params.content.trim();
      if (!content) {
        return { content: [{ type: "text" as const, text: "ERROR: memory content cannot be empty" }], details: {} };
      }

      await appendFile(targetPath, `\n${content}\n`, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Appended to ${params.layer} memory.` }],
        details: { layer: params.layer },
      };
    },
  };
}

export function createMemoryTools(rootDir: string, settings?: MemoryToolSettings): ToolDefinition[] {
  if (settings?.memoryEnabled === false) {
    return [];
  }
  const tools = [
    createMemorySearchTool(rootDir, settings),
    createMemoryGetTool(rootDir, settings),
  ];
  if (getMemoryBackendCapabilities(settings).writable) {
    tools.push(createMemoryAppendTool(rootDir));
  }
  return tools;
}

/**
 * Create a `reflect_on_performance` tool that asks the reflection service to
 * analyze recent agent performance and return actionable insights.
 */
export function createReflectOnPerformanceTool(
  reflectionService: AgentReflectionService,
  agentId: string,
): ToolDefinition {
  return {
    name: "reflect_on_performance",
    label: "Reflect on Performance",
    description:
      'Review your past task performance and generate insights for improvement. Optionally focus on a specific area like "code quality", "speed", or "testing".',
    parameters: reflectOnPerformanceParams,
    execute: async (_id: string, params: Static<typeof reflectOnPerformanceParams>) => {
      const triggerDetail = params.focus_area
        ? `Agent-initiated reflection focused on: ${params.focus_area}`
        : "Agent-initiated reflection";

      const reflection = await reflectionService.generateReflection(agentId, "manual", {
        triggerDetail,
      });

      if (!reflection) {
        return {
          content: [{ type: "text" as const, text: "No reflection data available — not enough history yet." }],
          details: {},
        };
      }

      const formattedText = [
        `Summary: ${reflection.summary}`,
        "",
        "Insights:",
        ...reflection.insights.map((insight, index) => `${index + 1}. ${insight}`),
        "",
        "Suggested Improvements:",
        ...reflection.suggestedImprovements.map((improvement, index) => `${index + 1}. ${improvement}`),
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: formattedText }],
        details: {},
      };
    },
  };
}

/**
 * Create a `list_agents` tool that lists all available agents.
 *
 * @param agentStore - AgentStore for agent discovery
 * @returns ToolDefinition for the `list_agents` tool
 */
export function createListAgentsTool(agentStore: AgentStore): ToolDefinition {
  return {
    name: "list_agents",
    label: "List Agents",
    description:
      "List all available agents in the system. Shows each agent's name, role, state, " +
      "personality (soul), and current assignment. Use this to discover which agents exist " +
      "and what they specialize in before delegating work.",
    parameters: listAgentsParams,
    execute: async (_id: string, params: Static<typeof listAgentsParams>) => {
      const filter: { role?: AgentCapability; state?: AgentState; includeEphemeral?: boolean } = {};
      if (params.role) filter.role = params.role as AgentCapability;
      if (params.state) filter.state = params.state as AgentState;
      if (params.includeEphemeral !== undefined) filter.includeEphemeral = params.includeEphemeral;

      const agents = await agentStore.listAgents(filter);

      if (agents.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agents found matching the specified filters." }],
          details: {},
        };
      }

      const lines = agents.map((agent) => {
        const parts: string[] = [
          `ID: ${agent.id}`,
          `Name: ${agent.name}`,
          `Role: ${agent.role}`,
          `State: ${agent.state}`,
        ];

        if (agent.title) parts.push(`Title: ${agent.title}`);
        if (agent.soul) parts.push(`Soul: ${agent.soul.slice(0, 200)}`);
        if (agent.instructionsText) {
          const snippet = agent.instructionsText.slice(0, 100);
          parts.push(`Custom Instructions: ${snippet}${agent.instructionsText.length > 100 ? "…" : ""}`);
        }
        if (agent.taskId) parts.push(`Current Task: ${agent.taskId}`);

        return parts.join("\n");
      });

      return {
        content: [{ type: "text" as const, text: `Available agents:\n\n${lines.join("\n\n")}` }],
        details: { agents },
      };
    },
  };
}

/**
 * Create a `delegate_task` tool that creates and assigns a task to a specific agent.
 *
 * @param agentStore - AgentStore for agent lookup
 * @param taskStore - TaskStore for task creation
 * @returns ToolDefinition for the `delegate_task` tool
 */
export function createDelegateTaskTool(agentStore: AgentStore, taskStore: TaskStore): ToolDefinition {
  return {
    name: "delegate_task",
    label: "Delegate Task",
    description:
      "Create a new task and assign it to a specific agent for execution. The task goes to " +
      "'todo' and will be picked up by the target agent on their next heartbeat cycle. " +
      "Use list_agents first to find available agents and their capabilities.",
    parameters: delegateTaskParams,
    execute: async (_id: string, params: Static<typeof delegateTaskParams>) => {
      // Validate target agent exists
      const agent = await agentStore.getAgent(params.agent_id);
      if (!agent) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Agent ${params.agent_id} not found` }],
          details: {},
        };
      }

      // Validate target agent is not ephemeral
      if (isEphemeralAgent(agent)) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Cannot delegate to ephemeral/runtime agent ${params.agent_id}` }],
          details: {},
        };
      }

      // Create task assigned to the target agent
      const task = await taskStore.createTask({
        description: params.description,
        dependencies: params.dependencies,
        column: "todo",
        assignedAgentId: params.agent_id,
      });

      const deps = task.dependencies.length ? ` (depends on: ${task.dependencies.join(", ")})` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Delegated to ${agent.name} (${agent.id}): Created ${task.id}${deps}. ` +
            `The task will be picked up by ${agent.name} on their next heartbeat cycle.`,
        }],
        details: { taskId: task.id, agentId: agent.id, agentName: agent.name },
      };
    },
  };
}

/**
 * Create a `send_message` tool that sends a message to another agent or user.
 *
 * @param messageStore - MessageStore for message persistence
 * @param fromAgentId - The agent ID sending the message
 * @returns ToolDefinition for the `send_message` tool
 */
export function createSendMessageTool(messageStore: MessageStore, fromAgentId: string): ToolDefinition {
  return {
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to another agent or user. The recipient will be woken if they have " +
      "`messageResponseMode: 'immediate'` configured.",
    parameters: sendMessageParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: Static<typeof sendMessageParams>, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      // Validate content length
      const content = params.content.trim();
      if (content.length === 0) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content cannot be empty" }],
          details: {},
        };
      }
      if (content.length > 2000) {
        return {
          content: [{ type: "text" as const, text: "ERROR: Message content exceeds 2000 character limit" }],
          details: {},
        };
      }

      try {
        const messageType = params.type ?? "agent-to-agent";
        const recipientType = messageType === "agent-to-user" ? "user" : "agent";

        const message = messageStore.sendMessage({
          fromId: fromAgentId,
          fromType: "agent",
          toId: params.to_id,
          toType: recipientType,
          content,
          type: messageType,
        });

        return {
          content: [{
            type: "text" as const,
            text: `Message sent to ${params.to_id} (ID: ${message.id})`,
          }],
          details: { messageId: message.id },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to send message: ${errorMessage}` }],
          details: {},
        };
      }
    },
  };
}

/**
 * Create a `read_messages` tool that reads inbox messages for an agent.
 *
 * @param messageStore - MessageStore for message retrieval
 * @param agentId - The agent ID whose inbox to read
 * @returns ToolDefinition for the `read_messages` tool
 */
export function createReadMessagesTool(messageStore: MessageStore, agentId: string): ToolDefinition {
  return {
    name: "read_messages",
    label: "Read Messages",
    description: "Read your inbox messages. Returns unread messages by default.",
    parameters: readMessagesParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_id: string, params: Static<typeof readMessagesParams>, _signal?: any, _onUpdate?: any, _ctx?: any) => {
      const unreadOnly = params.unread_only ?? true;
      const limit = params.limit ?? 20;

      try {
        const filter = {
          ...(unreadOnly ? { read: false as const } : {}),
          limit,
        };

        const messages = messageStore.getInbox(agentId, "agent", filter);

        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No messages" }],
            details: {},
          };
        }

        const lines = messages.map((msg: Message) => {
          const timestamp = new Date(msg.createdAt).toLocaleString();
          const readStatus = msg.read ? "[read] " : "[unread] ";
          return `${readStatus}[from: ${msg.fromId}] ${msg.content} (${timestamp})`;
        });

        return {
          content: [{
            type: "text" as const,
            text: `Messages (${messages.length}):\n${lines.join("\n")}`,
          }],
          details: { messages },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `ERROR: Failed to read messages: ${errorMessage}` }],
          details: {},
        };
      }
    },
  };
}
