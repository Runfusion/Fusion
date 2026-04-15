import { Capacitor } from "@capacitor/core";
import { EventEmitter } from "node:events";

export interface ShareTaskPayload {
  id: string;
  title?: string;
  description: string;
}

export interface ShareManagerOptions {
  /** Base URL for constructing deep links. Default: "fusion://task/" */
  deepLinkBaseUrl?: string;
}

export interface ShareEventMap {
  "share:success": { taskId: string };
  "share:cancelled": { taskId: string };
  "share:error": { taskId: string; error: Error };
}

type SharePlugin = typeof import("@capacitor/share");
type NavigatorSharePayload = {
  title: string;
  text: string;
  url: string;
};

type ShareCapacitorResult = {
  activityType?: string;
};

/** Fallback listener type for untyped event handling */
type FallbackListener = (...args: unknown[]) => void;

export class ShareManager extends EventEmitter {
  private readonly deepLinkBaseUrl: string;
  private initialized = false;
  private sharePlugin: SharePlugin["Share"] | null = null;

  constructor(options?: ShareManagerOptions) {
    super();
    this.deepLinkBaseUrl = options?.deepLinkBaseUrl ?? "fusion://task/";
  }

  override on<K extends keyof ShareEventMap>(
    event: K,
    listener: (payload: ShareEventMap[K]) => void,
  ): this;
  override on(event: string | symbol, listener: FallbackListener): this;
  override on(event: string | symbol, listener: FallbackListener): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ShareEventMap>(
    event: K,
    listener: (payload: ShareEventMap[K]) => void,
  ): this;
  override off(event: string | symbol, listener: FallbackListener): this;
  override off(event: string | symbol, listener: FallbackListener): this {
    return super.off(event, listener);
  }

  emit<K extends keyof ShareEventMap>(event: K, payload: ShareEventMap[K]): boolean;
  emit(event: string | symbol, payload?: unknown): boolean;
  emit(event: string | symbol, payload?: unknown): boolean {
    return super.emit(event, payload);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
  }

  async shareTask(task: ShareTaskPayload): Promise<boolean> {
    const sharePayload = this.buildPayload(task);

    try {
      if (Capacitor.isNativePlatform()) {
        const share = await this.loadSharePlugin();
        if (!share) {
          throw new Error("Native share plugin is unavailable");
        }

        const result = (await share.share(sharePayload)) as ShareCapacitorResult | undefined;
        if (result?.activityType === undefined) {
          this.emit("share:cancelled", { taskId: task.id });
          return false;
        }

        this.emit("share:success", { taskId: task.id });
        return true;
      }

      const navigatorShare = this.getNavigatorShare();
      if (navigatorShare) {
        try {
          await navigatorShare(sharePayload);
          this.emit("share:success", { taskId: task.id });
          return true;
        } catch (error) {
          if (this.isAbortError(error)) {
            this.emit("share:cancelled", { taskId: task.id });
            return false;
          }

          throw error;
        }
      }

      const clipboardWriteText = this.getClipboardWriter();
      if (!clipboardWriteText) {
        throw new Error("No share mechanism available on this platform");
      }

      await clipboardWriteText(sharePayload.url);
      this.emit("share:success", { taskId: task.id });
      return true;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emit("share:error", { taskId: task.id, error: normalizedError });
      return false;
    }
  }

  getDeepLinkBaseUrl(): string {
    return this.deepLinkBaseUrl;
  }

  async destroy(): Promise<void> {
    this.initialized = false;
    this.removeAllListeners();
  }

  private buildPayload(task: ShareTaskPayload): NavigatorSharePayload {
    const title = task.title ?? `Task ${task.id}`;
    const text =
      task.description.length > 200
        ? `${task.description.slice(0, 200)}...`
        : task.description;
    const url = `${this.deepLinkBaseUrl}${task.id}`;

    return { title, text, url };
  }

  private async loadSharePlugin(): Promise<SharePlugin["Share"] | null> {
    if (this.sharePlugin) {
      return this.sharePlugin;
    }

    try {
      const mod: SharePlugin = await import("@capacitor/share");
      this.sharePlugin = mod.Share;
      return this.sharePlugin;
    } catch {
      return null;
    }
  }

  private getNavigatorShare(): ((payload: NavigatorSharePayload) => Promise<void>) | null {
    const nav = globalThis.navigator as
      | (Navigator & { share?: (payload: NavigatorSharePayload) => Promise<void> })
      | undefined;

    if (!nav || typeof nav.share !== "function") {
      return null;
    }

    return nav.share.bind(nav);
  }

  private getClipboardWriter(): ((value: string) => Promise<void>) | null {
    const nav = globalThis.navigator as
      | (Navigator & { clipboard?: { writeText?: (value: string) => Promise<void> } })
      | undefined;

    const clipboard = nav?.clipboard;
    const writeText = clipboard?.writeText;
    if (typeof writeText !== "function" || !clipboard) {
      return null;
    }

    return writeText.bind(clipboard);
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: string }).name === "AbortError")
    );
  }
}
