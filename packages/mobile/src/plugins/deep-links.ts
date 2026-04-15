import { Capacitor } from "@capacitor/core";
import { EventEmitter } from "node:events";

export interface DeepLinkPayload {
  url: string;
  taskId?: string;
  projectId?: string;
  target?: string;
  params?: Record<string, string>;
}

export interface DeepLinkManagerOptions {
  /** Custom URL scheme. Default: "fusion://" */
  scheme?: string;
  /** Universal link hosts to recognize. Default: [] */
  universalLinkHosts?: string[];
}

export interface DeepLinkEventMap {
  "deeplink:received": DeepLinkPayload;
  "deeplink:error": { url: string; error: Error };
}

type AppModule = typeof import("@capacitor/app");
type AppListenerHandle = { remove: () => Promise<void> };

type HashChangeEventHandler = (event: HashChangeEvent) => void;

/** Fallback listener type for untyped event handling */
type FallbackListener = (...args: unknown[]) => void;

export class DeepLinkManager extends EventEmitter {
  private readonly scheme: string;
  private readonly universalLinkHosts: string[];
  private initialized = false;
  private appListenerHandle?: AppListenerHandle;
  private boundHashHandler?: HashChangeEventHandler;
  private appPlugin: AppModule["App"] | null = null;

  constructor(options?: DeepLinkManagerOptions) {
    super();
    this.scheme = options?.scheme ?? "fusion://";
    this.universalLinkHosts = options?.universalLinkHosts ?? [];
  }

  override on<K extends keyof DeepLinkEventMap>(
    event: K,
    listener: (payload: DeepLinkEventMap[K]) => void,
  ): this;
  override on(event: string | symbol, listener: FallbackListener): this;
  override on(event: string | symbol, listener: FallbackListener): this {
    return super.on(event, listener);
  }

  override off<K extends keyof DeepLinkEventMap>(
    event: K,
    listener: (payload: DeepLinkEventMap[K]) => void,
  ): this;
  override off(event: string | symbol, listener: FallbackListener): this;
  override off(event: string | symbol, listener: FallbackListener): this {
    return super.off(event, listener);
  }

  emit<K extends keyof DeepLinkEventMap>(event: K, payload: DeepLinkEventMap[K]): boolean;
  emit(event: string | symbol, payload?: unknown): boolean;
  emit(event: string | symbol, payload?: unknown): boolean {
    return super.emit(event, payload);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    if (Capacitor.isNativePlatform()) {
      const app = await this.loadAppPlugin();
      if (!app) {
        return;
      }

      this.appListenerHandle = await app.addListener("appUrlOpen", (event) => {
        this.handleUrl(event.url);
      });
      return;
    }

    const win = globalThis.window;
    if (!win || typeof win.addEventListener !== "function") {
      return;
    }

    this.boundHashHandler = () => {
      const hash = win.location.hash ?? "";
      if (!hash.startsWith("#deeplink=")) {
        return;
      }

      const encodedUrl = hash.slice("#deeplink=".length);
      if (!encodedUrl) {
        return;
      }

      try {
        const decodedUrl = decodeURIComponent(encodedUrl);
        this.handleUrl(decodedUrl);
      } catch (error) {
        const normalizedError =
          error instanceof Error
            ? error
            : new Error("Invalid deeplink hash payload");
        this.emit("deeplink:error", {
          url: encodedUrl,
          error: normalizedError,
        });
      }
    };

    win.addEventListener("hashchange", this.boundHashHandler);
  }

  handleUrl(url: string): DeepLinkPayload | null {
    try {
      const payload = this.parseUrl(url);
      this.emit("deeplink:received", payload);
      return payload;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emit("deeplink:error", {
        url,
        error: normalizedError,
      });
      return null;
    }
  }

  getScheme(): string {
    return this.scheme;
  }

  async destroy(): Promise<void> {
    if (this.appListenerHandle) {
      try {
        await this.appListenerHandle.remove();
      } catch (error) {
        console.warn("Failed to remove appUrlOpen listener", error);
      }
      this.appListenerHandle = undefined;
    }

    if (this.boundHashHandler && globalThis.window) {
      globalThis.window.removeEventListener("hashchange", this.boundHashHandler);
      this.boundHashHandler = undefined;
    }

    this.initialized = false;
    this.removeAllListeners();
  }

  private parseUrl(url: string): DeepLinkPayload {
    const parsedUrl = new URL(url);

    if (this.isCustomSchemeUrl(url, parsedUrl)) {
      return this.parseCustomScheme(url, parsedUrl);
    }

    if (this.isRecognizedUniversalLink(parsedUrl)) {
      return this.parseUniversalLink(url, parsedUrl);
    }

    throw new Error("Unsupported deep link URL");
  }

  private parseCustomScheme(url: string, parsedUrl: URL): DeepLinkPayload {
    const segments = [parsedUrl.hostname, ...parsedUrl.pathname.split("/").filter(Boolean)].filter(
      (segment) => segment.length > 0,
    );

    const payload: DeepLinkPayload = { url };
    const [first, second, third, fourth] = segments;

    if (first) {
      payload.target = first;
    }

    if (first === "task" && second) {
      payload.taskId = second;
    }

    if (first === "project" && second) {
      payload.projectId = second;
      if (third === "task" && fourth) {
        payload.taskId = fourth;
      }
    }

    const params = this.collectParams(parsedUrl.searchParams);
    if (Object.keys(params).length > 0) {
      payload.params = params;
    }

    return payload;
  }

  private parseUniversalLink(url: string, parsedUrl: URL): DeepLinkPayload {
    const payload: DeepLinkPayload = {
      url,
      taskId: parsedUrl.searchParams.get("task") ?? undefined,
      projectId: parsedUrl.searchParams.get("project") ?? undefined,
      target: parsedUrl.searchParams.get("target") ?? undefined,
    };

    const params = this.collectParams(parsedUrl.searchParams, ["task", "project", "target"]);
    if (Object.keys(params).length > 0) {
      payload.params = params;
    }

    return payload;
  }

  private collectParams(
    searchParams: URLSearchParams,
    exclusions: string[] = [],
  ): Record<string, string> {
    const params: Record<string, string> = {};
    const exclusionSet = new Set(exclusions);

    for (const [key, value] of searchParams.entries()) {
      if (exclusionSet.has(key)) {
        continue;
      }
      params[key] = value;
    }

    return params;
  }

  private isRecognizedUniversalLink(parsedUrl: URL): boolean {
    return (
      parsedUrl.protocol === "https:" &&
      this.universalLinkHosts.includes(parsedUrl.hostname)
    );
  }

  private isCustomSchemeUrl(url: string, parsedUrl: URL): boolean {
    const configuredSchemeProtocol = this.normalizeSchemeProtocol(this.scheme);
    return parsedUrl.protocol === configuredSchemeProtocol || url.startsWith(this.scheme);
  }

  private normalizeSchemeProtocol(scheme: string): string {
    if (scheme.endsWith("://")) {
      return `${scheme.slice(0, -3)}:`;
    }

    if (scheme.endsWith(":")) {
      return scheme;
    }

    return `${scheme}:`;
  }

  private async loadAppPlugin(): Promise<AppModule["App"] | null> {
    if (this.appPlugin) {
      return this.appPlugin;
    }

    try {
      const mod: AppModule = await import("@capacitor/app");
      this.appPlugin = mod.App;
      return this.appPlugin;
    } catch {
      return null;
    }
  }
}
