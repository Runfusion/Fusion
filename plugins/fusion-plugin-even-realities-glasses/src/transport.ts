import type { GlassesCard } from "./cards.js";

export type GlassesAction = {
  type: "start-work" | "request-review" | "quick-capture";
  taskId?: string;
  text?: string;
  timestamp: string;
};

export interface GlassesTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  pushCard(card: GlassesCard): Promise<void>;
  onAction(handler: (action: GlassesAction) => void | Promise<void>): void;
  receiveAction?(action: GlassesAction): Promise<void>;
  readonly connected?: boolean;
  readonly status?: {
    mode: "webhook";
    endpointConfigured: boolean;
    lastPushAt: string | null;
    lastActionAt: string | null;
    lastError: string | null;
  };
}

type WebhookTransportOptions = {
  companionWebhookUrl?: string;
  fetchImpl?: typeof fetch;
};

function normalizeWebhookUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, "");
}

export class WebhookGlassesTransport implements GlassesTransport {
  private handlers: Array<(action: GlassesAction) => void | Promise<void>> = [];
  private readonly fetchImpl: typeof fetch;
  private readonly companionWebhookUrl?: string;
  private _connected = false;
  private _lastPushAt: string | null = null;
  private _lastActionAt: string | null = null;
  private _lastError: string | null = null;

  constructor(options: WebhookTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.companionWebhookUrl = normalizeWebhookUrl(options.companionWebhookUrl);
  }

  get connected(): boolean {
    return this._connected && Boolean(this.companionWebhookUrl);
  }

  get status() {
    return {
      mode: "webhook" as const,
      endpointConfigured: Boolean(this.companionWebhookUrl),
      lastPushAt: this._lastPushAt,
      lastActionAt: this._lastActionAt,
      lastError: this._lastError,
    };
  }

  async connect(): Promise<void> {
    this._connected = true;
    this._lastError = this.companionWebhookUrl ? null : "companionWebhookUrl not configured";
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async pushCard(card: GlassesCard): Promise<void> {
    if (!this.companionWebhookUrl) {
      this._lastError = "companionWebhookUrl not configured";
      return;
    }

    try {
      const response = await this.fetchImpl(`${this.companionWebhookUrl}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card }),
      });
      if (!response.ok) {
        this._lastError = `companion webhook responded ${response.status}`;
        this._connected = false;
        throw new Error(this._lastError);
      }
      this._connected = true;
      this._lastPushAt = new Date().toISOString();
      this._lastError = null;
    } catch (error) {
      this._connected = false;
      this._lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  onAction(handler: (action: GlassesAction) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  async receiveAction(action: GlassesAction): Promise<void> {
    this._lastActionAt = new Date().toISOString();
    for (const handler of this.handlers) {
      await handler(action);
    }
  }
}
