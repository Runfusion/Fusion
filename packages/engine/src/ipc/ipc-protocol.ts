/**
 * IPC Protocol for child-process isolation mode.
 *
 * Defines message types for communication between the host (ProjectManager)
 * and worker (child process running InProcessRuntime internally).
 *
 * Message Flow:
 * 1. Host sends commands with unique correlation IDs
 * 2. Worker processes commands and sends responses with matching IDs
 * 3. Worker can also send events unsolicited (task events, health changes)
 */

import type { RuntimeStatus, RuntimeMetrics, ProjectRuntimeConfig } from "../project-runtime.js";
import type { Task, TaskStore } from "@fusion/core";
import type { Scheduler } from "../scheduler.js";

// ── Base Message Types ────────────────────────────────────────────────────

/**
 * Base interface for all IPC messages.
 */
export interface IpcMessage {
  /** Message type discriminator */
  type: string;
  /** Unique correlation ID for request/response matching */
  id: string;
  /** Message payload */
  payload: unknown;
}

// ── Command Types (Host → Worker) ───────────────────────────────────────────

/** Command type: Start the runtime */
export const START_RUNTIME = "START_RUNTIME" as const;
/** Command type: Stop the runtime */
export const STOP_RUNTIME = "STOP_RUNTIME" as const;
/** Command type: Get current status */
export const GET_STATUS = "GET_STATUS" as const;
/** Command type: Get runtime metrics */
export const GET_METRICS = "GET_METRICS" as const;
/** Command type: Get TaskStore reference (returns serialized state) */
export const GET_TASK_STORE = "GET_TASK_STORE" as const;
/** Command type: Get Scheduler reference (returns serialized state) */
export const GET_SCHEDULER = "GET_SCHEDULER" as const;
/** Command type: Ping for health check */
export const PING = "PING" as const;

/**
 * Union of all command types.
 */
export type IpcCommandType =
  | typeof START_RUNTIME
  | typeof STOP_RUNTIME
  | typeof GET_STATUS
  | typeof GET_METRICS
  | typeof GET_TASK_STORE
  | typeof GET_SCHEDULER
  | typeof PING;

/**
 * Payload for START_RUNTIME command.
 */
export interface StartRuntimePayload {
  config: ProjectRuntimeConfig;
}

/**
 * Payload for STOP_RUNTIME command.
 */
export interface StopRuntimePayload {
  /** Timeout in milliseconds for graceful shutdown (default: 30000) */
  timeoutMs?: number;
}

// ── Response Types (Worker → Host) ──────────────────────────────────────

/** Response type: Success */
export const OK = "OK" as const;
/** Response type: Error */
export const ERROR = "ERROR" as const;
/** Response type: Pong (ping reply) */
export const PONG = "PONG" as const;

/**
 * Union of all response types.
 */
export type IpcResponseType = typeof OK | typeof ERROR | typeof PONG;

/**
 * Successful response payload.
 */
export interface OkPayload {
  /** Response data (type depends on the command) */
  data?: unknown;
}

/**
 * Error response payload.
 */
export interface ErrorPayload {
  /** Error message */
  message: string;
  /** Error code for programmatic handling */
  code?: string;
  /** Stack trace (only in development) */
  stack?: string;
}

/**
 * Pong response payload for health checks.
 */
export interface PongPayload {
  /** ISO-8601 timestamp from the worker */
  timestamp: string;
}

// ── Event Types (Worker → Host, unsolicited) ─────────────────────────────

/** Event type: Task created */
export const TASK_CREATED = "TASK_CREATED" as const;
/** Event type: Task moved */
export const TASK_MOVED = "TASK_MOVED" as const;
/** Event type: Task updated */
export const TASK_UPDATED = "TASK_UPDATED" as const;
/** Event type: Runtime error */
export const ERROR_EVENT = "ERROR_EVENT" as const;
/** Event type: Health status changed */
export const HEALTH_CHANGED = "HEALTH_CHANGED" as const;

/**
 * Union of all event types.
 */
export type IpcEventType =
  | typeof TASK_CREATED
  | typeof TASK_MOVED
  | typeof TASK_UPDATED
  | typeof ERROR_EVENT
  | typeof HEALTH_CHANGED;

/**
 * Payload for TASK_CREATED event.
 */
export interface TaskCreatedPayload {
  task: Task;
}

/**
 * Payload for TASK_MOVED event.
 */
export interface TaskMovedPayload {
  task: Task;
  from: string;
  to: string;
}

/**
 * Payload for TASK_UPDATED event.
 */
export interface TaskUpdatedPayload {
  task: Task;
}

/**
 * Payload for ERROR event.
 */
export interface ErrorEventPayload {
  message: string;
  code?: string;
}

/**
 * Payload for HEALTH_CHANGED event.
 */
export interface HealthChangedPayload {
  status: RuntimeStatus;
  previous: RuntimeStatus;
}

// ── Type Guards ───────────────────────────────────────────────────────────

/**
 * Check if a message is a command.
 */
export function isIpcCommand(message: IpcMessage): boolean {
  const commandTypes: IpcCommandType[] = [
    START_RUNTIME,
    STOP_RUNTIME,
    GET_STATUS,
    GET_METRICS,
    GET_TASK_STORE,
    GET_SCHEDULER,
    PING,
  ];
  return commandTypes.includes(message.type as IpcCommandType);
}

/**
 * Check if a message is a response.
 */
export function isIpcResponse(message: IpcMessage): boolean {
  const responseTypes: IpcResponseType[] = [OK, ERROR, PONG];
  return responseTypes.includes(message.type as IpcResponseType);
}

/**
 * Check if a message is an event.
 */
export function isIpcEvent(message: IpcMessage): boolean {
  const eventTypes: IpcEventType[] = [
    TASK_CREATED,
    TASK_MOVED,
    TASK_UPDATED,
    ERROR_EVENT,
    HEALTH_CHANGED,
  ];
  return eventTypes.includes(message.type as IpcEventType);
}

// ── Serialized State Types ────────────────────────────────────────────────

/**
 * Serialized TaskStore state (for IPC transfer).
 * Full TaskStore objects cannot be passed across process boundaries.
 */
export interface SerializedTaskStore {
  rootDir: string;
  taskCount: number;
}

/**
 * Serialized Scheduler state (for IPC transfer).
 */
export interface SerializedScheduler {
  running: boolean;
}

// ── Helper Functions ────────────────────────────────────────────────────

/**
 * Create a command message.
 */
export function createCommand<T>(
  type: IpcCommandType,
  id: string,
  payload: T
): IpcMessage {
  return { type, id, payload };
}

/**
 * Create a response message.
 */
export function createResponse<T>(
  type: IpcResponseType,
  id: string,
  payload: T
): IpcMessage {
  return { type, id, payload };
}

/**
 * Create an event message.
 */
export function createEvent<T>(
  type: IpcEventType,
  id: string,
  payload: T
): IpcMessage {
  return { type, id, payload };
}

/**
 * Generate a unique correlation ID.
 */
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
