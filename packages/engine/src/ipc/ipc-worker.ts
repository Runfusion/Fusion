import { EventEmitter } from "node:events";
import type { IpcMessage, IpcCommandType, IpcEventType } from "./ipc-protocol.js";
import {
  OK,
  ERROR,
  PONG,
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  GET_TASK_STORE,
  GET_SCHEDULER,
  PING,
  ERROR_EVENT,
  isIpcCommand,
  generateCorrelationId,
} from "./ipc-protocol.js";
import { ipcLog } from "../logger.js";

type CommandHandler = (payload: unknown) => Promise<unknown> | unknown;

/**
 * IPC Worker handler for managing communication from a child process to the host.
 *
 * Handles:
 * - Receiving commands from the host
 * - Sending responses back to the host
 * - Sending events to the host
 * - Graceful shutdown signal handling
 *
 * This class is designed to run inside a forked child process.
 *
 * @example
 * ```typescript
 * // In child-process-worker.ts
 * if (process.send) {
 *   const ipcWorker = new IpcWorker();
 *
 *   // Register command handlers
 *   ipcWorker.onCommand("START_RUNTIME", async (payload) => {
 *     // ... start runtime
 *     return { success: true };
 *   });
 *
 *   // Send events to host
 *   ipcWorker.sendEvent("TASK_CREATED", { task });
 *
 *   // Handle graceful shutdown
 *   process.on("SIGTERM", () => {
 *     ipcWorker.shutdown();
 *   });
 * }
 * ```
 */
export class IpcWorker extends EventEmitter {
  private commandHandlers = new Map<IpcCommandType, CommandHandler>();
  private shuttingDown = false;

  /**
   * Create an IpcWorker instance.
   * Throws if not running in a forked child process (process.send unavailable).
   */
  constructor() {
    super();
    this.setMaxListeners(100);

    // Verify we're running in an IPC context
    if (!process.send) {
      throw new Error(
        "IpcWorker can only be instantiated in a forked child process (process.send unavailable)"
      );
    }

    this.setupListeners();
    this.setupSignalHandlers();
  }

  /**
   * Set up message listeners on the process.
   */
  private setupListeners(): void {
    process.on("message", (message: IpcMessage) => {
      this.handleMessage(message);
    });

    // Handle disconnect from parent
    process.on("disconnect", () => {
      ipcLog.warn("IPC channel disconnected from parent");
      this.emit("disconnect");
    });
  }

  /**
   * Set up signal handlers for graceful shutdown.
   */
  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      ipcLog.log(`Received ${signal}, initiating graceful shutdown...`);
      this.emit("shutdown", signal);

      // Give time for cleanup before exiting
      setTimeout(() => {
        process.exit(0);
      }, 5000);
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));

    // Handle uncaught errors
    process.on("uncaughtException", (error) => {
      ipcLog.error(`Uncaught exception: ${error.message}`);
      this.sendErrorEvent(error);
      this.emit("error", error);

      // Give time for error to be sent before exiting
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });

    process.on("unhandledRejection", (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      ipcLog.error(`Unhandled rejection: ${error.message}`);
      this.sendErrorEvent(error);
      this.emit("error", error);
    });
  }

  /**
   * Handle an incoming message from the parent process.
   */
  private async handleMessage(message: unknown): Promise<void> {
    // Validate message structure first
    if (!this.isValidMessage(message)) {
      ipcLog.warn(`Received malformed IPC message: ${JSON.stringify(message)}`);
      // Use a generated ID since we can't trust the message structure
      this.sendResponse(ERROR, generateCorrelationId(), {
        message: "Malformed message received",
        code: "MALFORMED_MESSAGE",
      });
      return;
    }

    // Now TypeScript knows message is IpcMessage
    // Check if this is a command
    if (!isIpcCommand(message)) {
      // Unknown message type
      this.sendResponse(ERROR, message.id, {
        message: `Unknown command type: ${message.type}`,
        code: "UNKNOWN_COMMAND",
      });
      return;
    }

    // Handle PING specially (no handler registration needed)
    if (message.type === PING) {
      this.sendResponse(PONG, message.id, {
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Look up command handler
    const handler = this.commandHandlers.get(message.type as IpcCommandType);
    if (!handler) {
      this.sendResponse(ERROR, message.id, {
        message: `No handler registered for command: ${message.type}`,
        code: "NO_HANDLER",
      });
      return;
    }

    // Execute handler and send response
    try {
      const result = await handler(message.payload);
      this.sendResponse(OK, message.id, { data: result });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      ipcLog.error(`Error handling command ${message.type}: ${err.message}`);
      this.sendResponse(ERROR, message.id, {
        message: err.message,
        code: (err as Error & { code?: string }).code ?? "HANDLER_ERROR",
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
  }

  /**
   * Register a command handler.
   *
   * @param type - Command type to handle
   * @param handler - Handler function that receives the payload and returns result
   */
  onCommand(type: IpcCommandType, handler: CommandHandler): void {
    this.commandHandlers.set(type, handler);
    ipcLog.log(`Registered handler for command: ${type}`);
  }

  /**
   * Unregister a command handler.
   *
   * @param type - Command type to unregister
   */
  offCommand(type: IpcCommandType): void {
    this.commandHandlers.delete(type);
    ipcLog.log(`Unregistered handler for command: ${type}`);
  }

  /**
   * Send a response to the parent process.
   *
   * @param type - Response type (OK, ERROR, or PONG)
   * @param id - Correlation ID matching the command
   * @param payload - Response payload
   */
  sendResponse(type: IpcResponseType, id: string, payload: unknown): void {
    if (this.shuttingDown) return;

    const message: IpcMessage = { type, id, payload };
    this.send(message);
  }

  /**
   * Send an event to the parent process.
   *
   * @param type - Event type
   * @param payload - Event payload
   */
  sendEvent(type: IpcEventType, payload: unknown): void {
    if (this.shuttingDown) return;

    const message: IpcMessage = {
      type,
      id: generateCorrelationId(),
      payload,
    };
    this.send(message);
  }

  /**
   * Send an error event to the parent process.
   *
   * @param error - Error to send
   */
  sendErrorEvent(error: Error): void {
    this.sendEvent(ERROR_EVENT, {
      message: error.message,
      code: (error as Error & { code?: string }).code,
    });
  }

  /**
   * Send a message to the parent process.
   */
  private send(message: IpcMessage): void {
    if (!process.send) {
      ipcLog.error("Cannot send message: process.send unavailable");
      return;
    }

    try {
      process.send(message, (err) => {
        if (err) {
          ipcLog.error(`Failed to send message: ${err.message}`);
        }
      });
    } catch (err) {
      ipcLog.error(`Error sending message: ${(err as Error).message}`);
    }
  }

  /**
   * Initiate graceful shutdown.
   * Notifies the parent and prevents further message sending.
   */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    ipcLog.log("IPC worker shutting down...");
    this.emit("shutdown");

    // Notify parent we're shutting down
    try {
      process.send?.({ type: "SHUTDOWN", id: generateCorrelationId(), payload: {} });
    } catch {
      // Ignore errors during shutdown
    }
  }

  /**
   * Check if the worker is in shutdown mode.
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Get the number of registered command handlers.
   */
  getHandlerCount(): number {
    return this.commandHandlers.size;
  }

  /**
   * Validate that a message has the expected structure.
   */
  private isValidMessage(message: unknown): message is IpcMessage {
    if (typeof message !== "object" || message === null) {
      return false;
    }

    const msg = message as Record<string, unknown>;

    return (
      typeof msg.type === "string" &&
      typeof msg.id === "string" &&
      "payload" in msg
    );
  }
}

// Import types for type checking
import type { IpcResponseType } from "./ipc-protocol.js";
