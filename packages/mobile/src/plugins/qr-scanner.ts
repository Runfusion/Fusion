export interface QrScanResult {
  serverUrl: string;
  authToken?: string | null;
}

export interface QrScannerAdapter {
  scan(): Promise<string>;
}

function parsePayload(raw: string): QrScanResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("QR scan returned empty payload");
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<QrScanResult>;
    if (typeof parsed.serverUrl === "string" && parsed.serverUrl.trim().length > 0) {
      return {
        serverUrl: parsed.serverUrl.trim(),
        authToken: parsed.authToken ?? null,
      };
    }
  } catch {
    // Fall through to URL parsing.
  }

  try {
    const url = new URL(trimmed);
    const authToken = url.searchParams.get("authToken") ?? url.searchParams.get("rt");
    return {
      serverUrl: `${url.protocol}//${url.host}`,
      authToken,
    };
  } catch {
    throw new Error("QR payload is not a valid Fusion connection payload");
  }
}

export class QrScanner {
  constructor(private readonly adapter?: QrScannerAdapter) {}

  async scanConnection(): Promise<QrScanResult> {
    if (!this.adapter) {
      throw new Error("QR scanner is not available on this platform");
    }

    const raw = await this.adapter.scan();
    return parsePayload(raw);
  }
}

export { parsePayload as parseQrConnectionPayload };
