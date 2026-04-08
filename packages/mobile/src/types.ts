export interface PluginEventMap {
  [event: string]: unknown;
}

export interface MobilePluginManager {
  start(): Promise<void>;
  destroy(): void | Promise<void>;
}
