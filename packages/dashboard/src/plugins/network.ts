import { Network, type ConnectionType } from "@capacitor/network";
import type {
  PluginManager,
  NetworkStatus,
  NetworkStatusCallback,
  PluginNetworkListenerHandle,
} from "./types.js";

export class NetworkManager implements PluginManager {
  private status: NetworkStatus;
  private listeners: Array<NetworkStatusCallback> = [];
  private networkListenerHandle: PluginNetworkListenerHandle | null = null;
  private initialized = false;
  private monitoring = false;

  constructor() {
    this.status = { connected: true, connectionType: "unknown" };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const currentStatus = await Network.getStatus();
      this.status = this.toNetworkStatus(currentStatus.connected, currentStatus.connectionType);
    } catch {
      // Network plugin may not be available in browser context
      this.status = { connected: true, connectionType: "unknown" };
    }

    await this.startMonitoring();
    this.initialized = true;
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoring) {
      return;
    }

    try {
      this.networkListenerHandle = await Network.addListener(
        "networkStatusChange",
        (status) => {
          const nextStatus = this.toNetworkStatus(status.connected, status.connectionType);
          const previousConnected = this.status.connected;
          this.status = nextStatus;

          // Emit specific events for going online/offline
          if (!previousConnected && nextStatus.connected) {
            this.emit("network:online", nextStatus);
          } else if (previousConnected && !nextStatus.connected) {
            this.emit("network:offline", nextStatus);
          }

          // Always emit general status change
          this.emit("network:change", nextStatus);
        },
      );
      this.monitoring = true;
    } catch {
      // Network plugin may not be available in browser context
      this.networkListenerHandle = null;
      this.monitoring = false;
    }
  }

  async stopMonitoring(): Promise<void> {
    if (this.networkListenerHandle) {
      try {
        await this.networkListenerHandle.remove();
      } catch {
        // Ignore listener cleanup errors
      }
      this.networkListenerHandle = null;
    }

    this.monitoring = false;
  }

  getStatus(): NetworkStatus {
    return { ...this.status };
  }

  get isOnline(): boolean {
    return this.status.connected;
  }

  get isMonitoring(): boolean {
    return this.monitoring;
  }

  onStatusChange(callback: NetworkStatusCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  private emit(_event: string, status: NetworkStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Prevent one listener error from breaking others
      }
    }
  }

  private toNetworkStatus(connected: boolean, connectionType: ConnectionType): NetworkStatus {
    return {
      connected,
      connectionType: connectionType as NetworkStatus["connectionType"],
    };
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async destroy(): Promise<void> {
    await this.stopMonitoring();
    this.listeners = [];
    this.initialized = false;
  }
}
