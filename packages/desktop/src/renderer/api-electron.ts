type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestPayload {
  method: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  port?: number;
}

export interface ApiResponsePayload {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  data?: unknown;
  error?: string;
}

export interface ElectronApiLike {
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>;
  getServerPort?: () => Promise<number>;
}

export interface WindowLike {
  electronAPI?: ElectronApiLike;
}

export interface ApiTransport {
  request<T = unknown>(path: string, opts?: RequestInit): Promise<T>;
}

export interface ApiClient {
  mode: "electron" | "web";
  transport: ApiTransport;
}

function normalizeMethod(method?: string): HttpMethod {
  const normalized = (method ?? "GET").toUpperCase();
  switch (normalized) {
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return normalized as HttpMethod;
    default:
      return "GET";
  }
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

export class FetchApiTransport implements ApiTransport {
  async request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const errorMessage = (payload as { error?: string }).error ?? `Request failed: ${response.status}`;
      throw new Error(errorMessage);
    }

    return payload as T;
  }
}

export class ElectronApiTransport implements ApiTransport {
  private readonly electronApi: ElectronApiLike;
  private serverPortPromise: Promise<number | undefined> | null = null;

  constructor(electronApi: ElectronApiLike) {
    this.electronApi = electronApi;
  }

  private async resolveServerPort(): Promise<number | undefined> {
    if (this.serverPortPromise) {
      return this.serverPortPromise;
    }

    this.serverPortPromise = (async () => {
      if (!this.electronApi.getServerPort) {
        return undefined;
      }

      try {
        return await this.electronApi.getServerPort();
      } catch {
        return undefined;
      }
    })();

    return this.serverPortPromise;
  }

  async request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
    if (!this.electronApi.invoke) {
      throw new Error("electronAPI.invoke is not available");
    }

    const port = await this.resolveServerPort();
    const payload: ApiRequestPayload = {
      method: normalizeMethod(opts.method),
      path,
      headers: toHeaderRecord(opts.headers),
      body: parseJsonBody(opts.body),
      port,
    };

    const result = (await this.electronApi.invoke("api-request", payload)) as ApiResponsePayload;

    if (result.status === 204) {
      return undefined as T;
    }

    if (result.status >= 400) {
      throw new Error(result.error ?? `Request failed: ${result.status}`);
    }

    return result.data as T;
  }
}

export function isElectronEnvironment(windowObject: WindowLike | undefined): boolean {
  return Boolean(windowObject?.electronAPI);
}

export function createApiClient(windowObject: WindowLike | undefined = typeof window !== "undefined" ? window : undefined): ApiClient {
  if (isElectronEnvironment(windowObject)) {
    return {
      mode: "electron",
      transport: new ElectronApiTransport(windowObject!.electronAPI!),
    };
  }

  return {
    mode: "web",
    transport: new FetchApiTransport(),
  };
}
