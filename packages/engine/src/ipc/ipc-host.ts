import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { IpcMessage, IpcCommandType, IpcResponseType } from "./ipc-protocol.js";
import { OK, ERROR, PONG, generateCorrelationId } from "./ipc-protocol.js";
import { ipcLog } from "../logger.js";

/**
 * Pending command waiting for a response.
 */
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  type: IpcCommandType;
}

/**
 * IPC Host handler for managing communication with a child process worker.
 *
 * Handles:
 * - Sending commands and correlating responses
 * - Forwarding events from worker to host listeners
 * - Detecting and handling IPC disconnections
 * - Timeout handling for commands
 *
 * @example
 * ```typescript
 * const child = fork(workerPath);
 * const ipcHost = new IpcHost(child);
 *
 * // Send command and await response
 * const response = await ipcHost.sendCommand("GET_STATUS", {});
 *
 * // Listen for events
 * ipcHost.on("TASK_CREATED", (payload) => {
 *   console.log("Task created:", payload.task.id);
 * });
 * ```
 */
export class IpcHost extends EventEmitter {
  private pendingCommands = new Map<string, PendingCommand>();
  private commandTimeoutMs = 30000; // 30 second default timeout
  private disconnected = false;

  /**
   * @param childProcess - The forked child process to communicate with
   * @param options - Optional configuration
   */
  constructor(
    private childProcess: ChildProcess,
    options?: { commandTimeoutMs?: number }
  ) {
    super();
    this.setMaxListeners(100);
    this.commandTimeoutMs = options?.commandTimeoutMs ?? 30000;
    this.setupListeners();
  }

  /**
   * Set up message and error listeners on the child process.
   */
  private setupListeners(): void {
    // Handle incoming messages from child
    this.childProcess.on("message", (message: IpcMessage) => {
      this.handleMessage(message);
    });

    // Handle child process errors
    this.childProcess.on("error", (error) => {
      ipcLog.error(`Child process error: ${error.message}`);
      this.handleDisconnection(error);
    });

    // Handle child process exit
    this.childProcess.on("exit", (code, signal) => {
      const reason = signal
        ? `Child process exited with signal ${signal}`
        : `Child process exited with code ${code}`;
      ipcLog.warn(reason);
      this.handleDisconnection(new Error(reason));
    });

    // Handle IPC channel disconnection
    this.childProcess.on("disconnect", () => {
      ipcLog.warn("Child process IPC channel disconnected");
      this.handleDisconnection(new Error("IPC channel disconnected"));
    });
  }

  /**
   * Handle an incoming message from the child process.
   */
  private handleMessage(message: IpcMessage): void {
    // Validate message structure
    if (!this.isValidMessage(message)) {
      ipcLog.warn(`Received malformed IPC message: ${JSON.stringify(message)}`);
      return;
    }

    // Handle responses to pending commands
    if (message.type === OK || message.type === ERROR || message.type === PONG) {
      const pending = this.pendingCommands.get(message.id);
      if (pending) {
        this.handleResponse(message, pending);
      } else {
        ipcLog.warn(`Received response for unknown command ID: ${message.id}`);
      }
      return;
    }

    // Handle events (forward to listeners)
    this.emit(message.type, message.payload);
    this.emit("message", message); // Generic message event
  }

  /**
   * Handle a response message for a pending command.
   */
  private handleResponse(
    message: IpcMessage,
    pending: PendingCommand
  ): void {
    // Clear the timeout
    clearTimeout(pending.timeout);
    this.pendingCommands.delete(message.id);

    if (message.type === OK) {
      pending.resolve((message.payload as { data?: unknown }).data);
    } else if (message.type === ERROR) {
      const errorPayload = message.payload as {
        message: string;
        code?: string;
        stack?: string;
      };
      const error = new Error(errorPayload.message);
      if (errorPayload.code) {
        (error as Error & { code: string }).code = errorPayload.code;
      }
      pending.reject(error);
    } else if (message.type === PONG) {
      pending.resolve(message.payload);
    }
  }

  /**
   * Handle disconnection from the child process.
   * Rejects all pending commands.
   */
  private handleDisconnection(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = true;

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`IPC disconnected: ${error.message}`));
    }
    this.pendingCommands.clear();

    this.emit("disconnect", error);
  }

  /**
   * Send a command to the child process and await a response.
   *
   * @param type - Command type
   * @param payload - Command payload
   * @param timeoutMs - Optional timeout override
   * @returns Promise that resolves with the response data
   * @throws Error if the command times out or IPC disconnects
   */
  async sendCommand<T = unknown>(
    type: IpcCommandType,
    payload: unknown,
    timeoutMs?: number
  ): Promise<T> {
    if (this.disconnected) {
      throw new Error("Cannot send command: IPC channel disconnected");
    }

    const id = generateCorrelationId();
    const message: IpcMessage = { type, id, payload };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command ${type} timed out after ${timeoutMs ?? this.commandTimeoutMs}ms`));
      }, timeoutMs ?? this.commandTimeoutMs);

      // Store pending command
      this.pendingCommands.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        type,
      });

      // Send message to child
      try {
        if (!this.childProcess.send) {
          throw new Error("Child process does not have IPC channel");
        }
        this.childProcess.send(message, (err) => {
          if (err) {
            clearTimeout(timeout);
            this.pendingCommands.delete(id);
            reject(new Error(`Failed to send command: ${err.message}`));
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingCommands.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Send a ping to check if the child process is responsive.
   *
   * @param timeoutMs - Timeout for pong response (default: 5000)
   * @returns Promise that resolves with pong payload or rejects on timeout
   */
  async ping(timeoutMs = 5000): Promise<{ timestamp: string }> {
    return this.sendCommand("PING", {}, timeoutMs);
  }

  /**
   * Check if the IPC channel is connected.
   */
  isConnected(): boolean {
    return !this.disconnected && this.childProcess.connected;
  }

  /**
   * Get the underlying child process.
   */
  getChildProcess(): ChildProcess {
    return this.childProcess;
  }

  /**
   * Disconnect the IPC channel and clean up.
   */
  disconnect(): void {
    this.handleDisconnection(new Error("Host initiated disconnect"));

    if (this.childProcess.connected) {
      this.childProcess.disconnect();
    }

    this.removeAllListeners();
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

  /**
   * Get the number of pending commands.
   */
  getPendingCommandCount(): number {
    return this.pendingCommands.size;
  }
}
