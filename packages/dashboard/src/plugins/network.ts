import type {
  PluginManager,
  NetworkStatus,
  NetworkStatusCallback,
  PluginNetworkListenerHandle,
} from "./types.js";

type NativeConnectionType = "wifi" | "cellular" | "none" | "unknown";

interface NativeNetworkStatus {
  connected: boolean;
  connectionType: NativeConnectionType;
}

interface NativeNetworkPlugin {
  getStatus: () => Promise<NativeNetworkStatus>;
  addListener: (
    eventName: "networkStatusChange",
    callback: (status: NativeNetworkStatus) => void,
  ) => PluginNetworkListenerHandle | Promise<PluginNetworkListenerHandle>;
}

interface CapacitorGlobal {
  Capacitor?: {
    Plugins?: Record<string, unknown>;
  };
}

function getNativeNetworkPlugin(): NativeNetworkPlugin | null {
  const plugins = (globalThis as CapacitorGlobal).Capacitor?.Plugins;
  const candidate = plugins?.Network as Partial<NativeNetworkPlugin> | undefined;

  if (!candidate || typeof candidate.getStatus !== "function" || typeof candidate.addListener !== "function") {
    return null;
  }

  return candidate as NativeNetworkPlugin;
}

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

    const networkPlugin = getNativeNetworkPlugin();

    try {
      if (networkPlugin) {
        const currentStatus = await networkPlugin.getStatus();
        this.status = this.toNetworkStatus(currentStatus.connected, currentStatus.connectionType);
      } else {
        this.status = { connected: true, connectionType: "unknown" };
      }
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

    const networkPlugin = getNativeNetworkPlugin();
    if (!networkPlugin) {
      this.networkListenerHandle = null;
      this.monitoring = false;
      return;
    }

    try {
      const listenerHandle = networkPlugin.addListener(
        "networkStatusChange",
        (status: NativeNetworkStatus) => {
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

      this.networkListenerHandle = await Promise.resolve(listenerHandle);
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

  private toNetworkStatus(connected: boolean, connectionType: NativeConnectionType): NetworkStatus {
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
